/**
 * `domains.toml`: the file that says which hostnames reach which page.
 *
 * The cases that matter are the ones where being wrong is quiet — an
 * interpolation that resolves to nothing, an entry deleted from the file, a
 * site with no file at all — plus the end of the chain: a hostname declared in
 * the file actually serving that page.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DomainRepository, TemplateRepository } from '@bunbraco/data'
import {
  DOMAINS_BACKUP_FILE,
  DOMAINS_FILE,
  parseDomainsFile,
  resolvePlaceholders,
  syncDomainsFile,
  undoDomainsFile,
  writeDomains,
  writeDomainsFile,
} from '@bunbraco/server'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

/** `${SITE_HOST}` written so the linter does not read it as an unescaped template. */
const SITE_HOST = `\${SITE_HOST}`
const HOST = `\${HOST}`
const SITE_OTHER_HOST = `\${OTHER_HOST}`

const TYPE_KEY = '2b6c2d1e-9b48-4a7f-8d53-4f2f0f5c2a01'
const TYPE = `[document-type]
key = "${TYPE_KEY}"
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
templates = ["page"]
default-template = "page"

[[property]]
key = "2b6c2d1e-9b48-4a7f-8d53-4f2f0f5c2a02"
alias = "title"
name = "Title"
type = "textstring"
`

const VIEW = `export default function Page({ model }) {
  return <main><h1>{model.text('title')}</h1></main>
}
`

describe('the domains file', () => {
  test('reads what it declares, and says what it cannot', () => {
    const read = parseDomainsFile(`
[[domain]]
node = "/"
host = "harbourstone.example"

[[domain]]
node = "/French"
host = "fr.harbourstone.example"
culture = "fr-FR"
default-culture = "fr-FR"

[[domain]]
host = "orphan.example"

[[domain]]
node = "/Nothing"
`)
    expect(read.declarations).toEqual([
      { node: '/', host: 'harbourstone.example', culture: undefined, defaultCulture: undefined },
      {
        node: '/French',
        host: 'fr.harbourstone.example',
        culture: 'fr-FR',
        defaultCulture: 'fr-FR',
      },
    ])
    expect(read.problems).toEqual([
      'domain[2]: no `node`',
      'domain[3]: needs a `host`, a `default-culture`, or both',
    ])
  })

  test('is written as a file somebody could have written by hand, and reads back the same', () => {
    const declarations = [
      { node: '/', host: SITE_HOST },
      { node: '/French', host: 'fr.example', culture: 'fr-FR', defaultCulture: 'fr-FR' },
    ]
    const written = writeDomainsFile(declarations)
    expect(written).toContain('[[domain]]')
    expect(written).toContain(`host = "${SITE_HOST}"`)
    expect(parseDomainsFile(written).declarations).toEqual(
      declarations.map((d) => ({ culture: undefined, defaultCulture: undefined, ...d })),
    )
  })

  test('refuses TOML it cannot read rather than applying half of it', () => {
    const read = parseDomainsFile('[[domain]\nnode = "/"')
    expect(read.declarations).toEqual([])
    expect(read.problems[0]).toContain('invalid TOML')
  })

  test('takes hostnames from the environment, and reports one that is not set', () => {
    expect(resolvePlaceholders(`${HOST}/shop`, { HOST: 'a.example' })).toEqual({
      value: 'a.example/shop',
      missing: [],
    })
    expect(resolvePlaceholders(HOST, {})).toEqual({ value: '', missing: ['HOST'] })
    // Empty is as absent: an unset variable in a deployment is usually an empty one.
    expect(resolvePlaceholders(HOST, { HOST: '' }).missing).toEqual(['HOST'])
    expect(resolvePlaceholders('plain.example', {}).missing).toEqual([])
  })
})

describe(`applying the domains file (${dialectUnderTest})`, () => {
  const open: Harness[] = []
  const dirs: string[] = []

  afterEach(async () => {
    while (open.length > 0) await open.pop()?.db.close()
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  async function site(domains?: string) {
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    const root = mkdtempSync(join(process.cwd(), 'output', 'domains-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(root, 'Views'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE)
    writeFileSync(join(root, 'Views', 'page.tsx'), VIEW)
    if (domains !== undefined) writeFileSync(join(root, DOMAINS_FILE), domains)
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        viewsDir: join(root, 'Views'),
      },
    })
    open.push(h)

    const template = (await new TemplateRepository(h.server.db).byAlias('page'))?.key as string
    const page = async (name: string, parent?: string) => {
      const created = await h.post(`${V1}/document`, {
        documentType: { id: TYPE_KEY },
        template: { id: template },
        parent: parent ? { id: parent } : null,
        values: [{ alias: 'title', culture: null, segment: null, value: name }],
        variants: [{ culture: null, segment: null, name }],
      })
      expect(created.status, `creating ${name}`).toBe(201)
      const key = created.headers.get('umb-generated-resource') as string
      expect((await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
        200,
      )
      return key
    }
    const bound = async () =>
      (await new DomainRepository(h.server.db).all()).map((row) => row.domainName)
    return { h, root, page, bound }
  }

  test('binds what the file declares, and the site answers on it', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    await page('Home')
    writeFileSync(
      join(root, DOMAINS_FILE),
      writeDomainsFile([{ node: '/', host: 'harbourstone.example' }]),
    )

    const report = await syncDomainsFile(h.server.db, root)
    expect(report.problems).toEqual([])
    expect(report.applied).toEqual([
      { node: '/', host: 'harbourstone.example', culture: undefined },
    ])
    expect(await bound()).toEqual(['harbourstone.example'])

    // The end of the chain: a request on that hostname reaches that page.
    h.server.cache.invalidate()
    const response = await h.server.fetch(new Request('http://harbourstone.example/'))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<h1>Home</h1>')
  })

  test('takes the hostname from the environment, and skips one that is not set', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    const home = await page('Home')
    await page('French', home)
    writeFileSync(
      join(root, DOMAINS_FILE),
      writeDomainsFile([
        { node: '/', host: SITE_HOST },
        { node: '/Home/French', host: 'fixed.example' },
      ]),
    )

    const report = await syncDomainsFile(h.server.db, root, { SITE_HOST: '' })
    // The unset one is reported by name rather than bound to a half-built
    // hostname, and the entry beside it is applied regardless.
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]).toContain('SITE_HOST')
    expect(await bound()).toEqual(['fixed.example'])

    const resolved = await syncDomainsFile(h.server.db, root, { SITE_HOST: 'live.example' })
    expect(resolved.problems).toEqual([])
    expect((await bound()).sort()).toEqual(['fixed.example', 'live.example'])
  })

  test('unbinds what the file no longer declares, which is how one is taken away', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    const home = await page('Home')
    await page('French', home)
    const file = join(root, DOMAINS_FILE)
    writeFileSync(
      file,
      writeDomainsFile([
        { node: '/', host: 'first.example' },
        { node: '/Home/French', host: 'second.example' },
      ]),
    )
    await syncDomainsFile(h.server.db, root)
    expect((await bound()).sort()).toEqual(['first.example', 'second.example'])

    writeFileSync(file, writeDomainsFile([{ node: '/', host: 'first.example' }]))
    const report = await syncDomainsFile(h.server.db, root)
    // The page the file stopped naming is unbound, and counted.
    expect(await bound()).toEqual(['first.example'])
    expect(report.removed).toBe(1)

    // And emptying the file entirely unbinds the lot.
    writeFileSync(file, writeDomainsFile([]))
    const emptied = await syncDomainsFile(h.server.db, root)
    expect(await bound()).toEqual([])
    expect(emptied.removed).toBe(1)
  })

  test('refuses to let two entries name the same page in different words', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    await page('Home')
    writeFileSync(
      join(root, DOMAINS_FILE),
      writeDomainsFile([
        { node: '/', host: 'first.example' },
        { node: '/Home', host: 'second.example' },
      ]),
    )

    // Each entry states that page's whole assignment, so applying both would
    // mean the second quietly replacing the first.
    const report = await syncDomainsFile(h.server.db, root)
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]).toContain('the same page')
    expect(await bound()).toEqual(['first.example'])
  })

  test('leaves a site with no file alone, hostnames and all', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    const home = await page('Home')
    expect(
      (
        await h.put(`${V1}/document/${home}/domains`, {
          defaultIsoCode: null,
          domains: [{ domainName: 'set-by-hand.example', isoCode: 'en-US' }],
        })
      ).status,
    ).toBe(200)

    const report = await syncDomainsFile(h.server.db, root)
    expect(report.action).toBe('absent')
    // Nothing to converge onto means nothing is converged: the backoffice stays
    // the only way on a site that has never written the file.
    expect(await bound()).toEqual(['set-by-hand.example'])
  })

  test('refuses what it cannot bind, and says which entry', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    await page('Home')
    writeFileSync(
      join(root, DOMAINS_FILE),
      writeDomainsFile([
        { node: '/Nowhere', host: 'a.example' },
        { node: '/', host: 'b.example', culture: 'fr-FR' },
      ]),
    )

    const report = await syncDomainsFile(h.server.db, root)
    expect(report.problems).toHaveLength(2)
    expect(report.problems.join('\n')).toContain('/Nowhere')
    // A culture the site has not got: the language has to exist first.
    expect(report.problems.join('\n')).toContain('fr-FR')
    expect(await bound()).toEqual([])
  })

  test('will not guess which root page `/` means when there is more than one', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    await page('Home')
    await page('Another')
    writeFileSync(join(root, DOMAINS_FILE), writeDomainsFile([{ node: '/', host: 'a.example' }]))

    const report = await syncDomainsFile(h.server.db, root)
    expect(report.problems[0]).toContain('2 root pages')
    expect(report.problems[0]).toContain('Home')
    expect(await bound()).toEqual([])
  })

  test('the file the CLI writes is the file the sync reads', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page } = await site()
    await page('Home')
    const file = join(root, DOMAINS_FILE)
    writeFileSync(file, writeDomainsFile([{ node: '/', host: 'round.example', culture: 'en-US' }]))
    const report = await syncDomainsFile(h.server.db, root)
    expect(report.problems).toEqual([])
    expect(readFileSync(file, 'utf8')).toContain('culture = "en-US"')
    expect(report.applied[0]?.culture).toBe('en-US')
  })

  test('a hostname with no culture of its own serves the default one', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page } = await site()
    await page('Home')
    writeFileSync(
      join(root, DOMAINS_FILE),
      writeDomainsFile([{ node: '/', host: 'plain.example' }]),
    )
    expect((await syncDomainsFile(h.server.db, root)).problems).toEqual([])
    // The repository wants a real language, so leaving the culture out must not
    // reach it as an empty string — which refused the binding outright.
    const rows = await new DomainRepository(h.server.db).all()
    expect(rows[0]?.isoCode).toBe('en-US')
  })

  test('keeps the file it replaced, so a wrong hostname is one command to undo', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    await page('Home')
    await writeDomains(root, [{ node: '/', host: 'right.example' }])
    await syncDomainsFile(h.server.db, root)

    const written = await writeDomains(root, [{ node: '/', host: 'typo.exmaple' }])
    expect(written.backup).toBeTruthy()
    await syncDomainsFile(h.server.db, root)
    expect(await bound()).toEqual(['typo.exmaple'])

    const undone = await undoDomainsFile(root)
    expect(undone.ok).toBe(true)
    await syncDomainsFile(h.server.db, root)
    expect(await bound()).toEqual(['right.example'])

    // Undo is itself undoable: the file it replaced is now the backup.
    expect((await undoDomainsFile(root)).ok).toBe(true)
    await syncDomainsFile(h.server.db, root)
    expect(await bound()).toEqual(['typo.exmaple'])
  })

  test('there is nothing to undo before anything has been written', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { root } = await site()
    const undone = await undoDomainsFile(root)
    expect(undone.ok).toBe(false)
    expect(undone.message).toContain(DOMAINS_BACKUP_FILE)
  })

  test('a save in the backoffice writes the file too, and says so', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, root, page, bound } = await site()
    const home = await page('Home')
    // The site keeps a file, so the dialog has to keep it in step — otherwise
    // the next boot converges onto the file and undoes what was just saved.
    await writeDomains(root, [
      { node: '/', host: 'from-file.example' },
      { node: 'ANOTHER', host: SITE_OTHER_HOST },
    ])

    const response = await h.put(`${V1}/document/${home}/domains`, {
      defaultIsoCode: null,
      domains: [{ domainName: 'from-dialog.example', isoCode: 'en-US' }],
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Umb-Notifications')).toContain(DOMAINS_FILE)
    expect(await bound()).toEqual(['from-dialog.example'])

    const declarations = parseDomainsFile(readFileSync(join(root, DOMAINS_FILE), 'utf8'))
    expect(declarations.declarations.map((d) => d.host)).toContain('from-dialog.example')
    // Another page's entry is left exactly as written: rewriting the file from
    // the database would bake this machine's environment into it.
    expect(declarations.declarations.map((d) => d.host)).toContain(SITE_OTHER_HOST)

    // And the next boot leaves what the dialog saved alone, because the file agrees.
    await syncDomainsFile(h.server.db, root)
    expect(await bound()).toEqual(['from-dialog.example'])
  })

  test('leaves the dialog alone on a site that keeps no file', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { h, page, bound } = await site()
    const home = await page('Home')
    const response = await h.put(`${V1}/document/${home}/domains`, {
      defaultIsoCode: null,
      domains: [{ domainName: 'dialog-only.example', isoCode: 'en-US' }],
    })
    expect(response.status).toBe(200)
    // Nothing about a file, because there is none to write.
    expect(response.headers.get('Umb-Notifications') ?? '').not.toContain(DOMAINS_FILE)
    expect(await bound()).toEqual(['dialog-only.example'])
  })
})
