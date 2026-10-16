/**
 * Story 104: a whole site in one file. The tarball streams, its integrity hash
 * is computed as files pass and must agree with the reader's, and what it
 * carries is everything a site is — less domains and, unless asked, people.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@crombolo/core'
import { SYSTEM_MEMBER_TYPE } from '@crombolo/data'
import {
  exportSite,
  extractTarball,
  TarballWriter,
  VERSION,
  writeNpmTarball,
} from '@crombolo/server'
import {
  type BundleNode,
  type ContentSet,
  loadBundle,
  openBundle,
  sanitise,
} from '@crombolo/transfer'
import { dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const PASSPHRASE = 'a passphrase long enough to use'

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const temp = (name: string) => {
  const dir = mkdtempSync(join(process.cwd(), 'output', `${name}-`))
  dirs.push(dir)
  return dir
}

describe('the tarball', () => {
  test('streams in and out, long paths and large files included', async () => {
    const dir = temp('tar')
    const big = crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024 + 7))
    const long = `content/blobs/${'deep/'.repeat(25)}photo.png`
    const writer = TarballWriter.create(join(dir, 'site.tgz'))
    await writer.add('package.json', new TextEncoder().encode('{}\n'))
    await writer.add('content/empty.txt', new Uint8Array(0))
    async function* chunks() {
      for (let at = 0; at < big.length; at += 65536) yield big.subarray(at, at + 65536)
    }
    await writer.addStream(long, big.length, chunks())
    await writer.close()

    const out = join(dir, 'out')
    const paths = await extractTarball(join(dir, 'site.tgz'), out)
    expect(paths).toEqual(['package.json', 'content/empty.txt', long.replace(/^package\//, '')])
    expect(new Uint8Array(readFileSync(join(out, ...long.split('/'))))).toEqual(big)
    expect(readFileSync(join(out, 'content', 'empty.txt')).length).toBe(0)
  })

  test('reads what the in-memory writer packs', async () => {
    const dir = temp('tar')
    const packed = writeNpmTarball([{ path: 'a/b.txt', bytes: new TextEncoder().encode('hello') }])
    writeFileSync(join(dir, 'p.tgz'), packed)
    await extractTarball(join(dir, 'p.tgz'), join(dir, 'out'))
    expect(readFileSync(join(dir, 'out', 'a', 'b.txt'), 'utf8')).toBe('hello')
  })

  test('a file that is not the size it said is refused', async () => {
    const dir = temp('tar')
    const writer = TarballWriter.create(join(dir, 'x.tgz'))
    async function* one() {
      yield new Uint8Array(3)
    }
    await expect(writer.addStream('f', 5, one())).rejects.toThrow('was 3 bytes, not 5')
    await writer.abort()
  })
})

describe('anonymising', () => {
  const node = (values: unknown[]): BundleNode =>
    ({
      key: 'k',
      kind: 'document',
      contentType: { key: 't', alias: 'page' },
      parent: null,
      sortOrder: 0,
      template: null,
      variants: [{ culture: null, segment: null, name: 'Write to ada@example.com' }],
      values: values.map((value) => ({
        property: 'p',
        culture: null,
        segment: null,
        editor: 'x',
        value,
      })),
      access: { loginNode: 'l', errorNode: 'e', memberGroups: [], memberUserNames: ['ada', 'eve'] },
    }) as unknown as BundleNode
  const set = (nodes: BundleNode[]) => ({ manifest: {}, nodes }) as unknown as ContentSet

  test('replaces addresses everywhere, the same one the same way, and drops users', () => {
    const result = sanitise({
      set: set([node(['Mail ada@example.com', { nested: ['bob@example.org'] }])]),
      people: {
        memberGroups: [{ key: 'g', name: 'Staff' }],
        userGroups: [],
        users: [
          {
            key: 'u',
            name: 'Admin',
            userName: 'admin',
            email: 'admin@example.com',
            languageIsoCode: null,
            disabled: false,
            passwordHash: 'h',
            passwordConfig: null,
            groupAliases: [],
          },
        ],
        members: [
          {
            key: 'm',
            name: 'Ada Lovelace',
            memberTypeAlias: 'Member',
            email: 'ada@example.com',
            username: 'ada',
            isApproved: true,
            isLockedOut: false,
            passwordHash: 'secret',
            passwordConfig: null,
            groupKeys: ['g'],
            values: [],
          },
        ],
      },
      dictionary: '<Value>Ask bob@example.org</Value>',
    })
    const text = JSON.stringify(result)
    expect(text).not.toMatch(/ada@example\.com|bob@example\.org|admin@example\.com|Lovelace|secret/)
    expect(result.people?.users).toEqual([])
    expect(result.people?.members[0]).toMatchObject({
      name: 'Member 1',
      username: 'member-1',
      email: 'member-1@example.invalid',
      passwordHash: null,
      groupKeys: ['g'],
    })
    const [only] = result.set.nodes
    // The member's address maps to the member's stand-in wherever it appears.
    expect(only?.values[0]?.value).toBe('Mail member-1@example.invalid')
    expect(result.dictionary).toBe(
      `<Value>Ask ${(only?.values[1]?.value as { nested: string[] } | undefined)?.nested[0]}</Value>`,
    )
    expect(only?.access?.memberUserNames).toEqual(['member-1'])
  })
})

const PAGE = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
components = ["page"]
default-component = "page"

[[property]]
alias = "contact"
name = "Contact"
type = "textstring"
`

/** A site with something in every section, a page with a value, a photo and a member. */
async function site() {
  const root = temp('site')
  for (const dir of ['schema/content-types', 'components', 'css', 'scripts', 'media'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE)
  writeFileSync(join(root, 'components', 'page.tsx'), 'export default () => <main />\n')
  writeFileSync(join(root, 'css', 'site.css'), 'body { color: red }\n')
  writeFileSync(join(root, 'scripts', 'site.js'), 'console.log("hi")\n')
  const h = await signedInServer({
    config: {
      siteDir: root,
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      stylesheetsDir: join(root, 'css'),
      scriptsDir: join(root, 'scripts'),
      mediaDir: join(root, 'media'),
    },
  })
  open.push(h)

  const types = await h.json<{ items: { id: string; alias?: string; name: string }[] }>(
    `${V1}/tree/document-type/root?take=100`,
  )
  const page = types.items.find((t) => t.name === 'Page')?.id as string
  const created = await h.post(`${V1}/document`, {
    documentType: { id: page },
    parent: null,
    values: [{ alias: 'contact', culture: null, segment: null, value: 'ada@example.com' }],
    variants: [{ culture: null, segment: null, name: 'Home' }],
  })
  expect(created.status).toBe(201)
  const home = created.headers.get('umb-generated-resource') as string
  expect((await h.put(`${V1}/document/${home}/publish`, { publishSchedules: [] })).status).toBe(200)

  const upload = crypto.randomUUID()
  const form = new FormData()
  form.set('Id', upload)
  form.set('File', new File([new Uint8Array([1, 2, 3, 4, 5])], 'photo.png'))
  expect((await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })).status).toBe(201)
  const photo = await h.post(`${V1}/media`, {
    mediaType: { id: SYSTEM_MEDIA_TYPE_KEYS.Image },
    parent: null,
    values: [
      {
        alias: 'umbracoFile',
        culture: null,
        segment: null,
        value: { src: '', temporaryFileId: upload, crops: [], focalPoint: null },
      },
    ],
    variants: [{ culture: null, segment: null, name: 'Photo' }],
  })
  expect(photo.status).toBe(201)

  const member = await h.post(`${V1}/member`, {
    memberType: { id: SYSTEM_MEMBER_TYPE.key },
    email: 'ada@example.com',
    username: 'ada',
    password: 'correct-horse-battery',
    isApproved: true,
    groups: [],
    values: [],
    variants: [{ culture: null, segment: null, name: 'Ada' }],
  })
  expect(member.status).toBe(201)
  expect(
    (
      await h.post(`${V1}/dictionary`, {
        name: 'Greeting',
        parent: null,
        translations: [{ isoCode: 'en-US', translation: 'Write to ada@example.com' }],
      })
    ).status,
  ).toBe(201)
  return { h, root }
}

/** Exports, unpacks and loads the file, as an import would read it. */
async function exported(h: Harness, options: Parameters<typeof exportSite>[2]) {
  const result = await exportSite(h.server.db, h.server.config, options)
  const dir = temp('unpacked')
  await extractTarball(result.out, dir)
  const loaded = loadBundle(join(dir, 'content'))
  if (!loaded.set) throw new Error(loaded.problems.map((p) => p.message).join('; '))
  return { result, dir, loaded: { ...loaded, set: loaded.set } }
}

describe(`a whole-site export (${dialectUnderTest})`, () => {
  test('carries every section, the content and the media, and reads back whole', async () => {
    const { h } = await site()
    const out = join(temp('out'), 'site.tgz')
    const { result, dir, loaded } = await exported(h, { out })
    expect(loaded.problems).toEqual([])
    const manifest = loaded.set.manifest
    expect(manifest.scope).toBe('site')
    expect(manifest.media).toBeUndefined()
    expect(manifest.provenance.cmsVersion).toBe(VERSION)
    expect(manifest.requires).toBeUndefined()
    expect(Object.keys(manifest.carries ?? {}).sort()).toEqual([
      'components',
      'dictionary',
      'schema',
      'scripts',
      'styles',
    ])
    expect(manifest.carries?.schema).toContain('schema/content-types/page.toml')
    expect(manifest.counts).toMatchObject({ document: 1, media: 1 })
    expect(manifest.blobs.every((blob) => blob.included)).toBe(true)
    expect(result.media.carried).toBe(1)
    expect(result.people).toEqual({ members: 0, users: 0 })
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(pkg).toMatchObject({
      private: true,
      peerDependencies: { '@crombolo/crombolo': `>=${VERSION}` },
    })
    expect(existsSync(`${out}.partial`)).toBe(false)
  })

  test('without media, says so and carries no files for it', async () => {
    const { h } = await site()
    const { loaded, dir, result } = await exported(h, {
      out: join(temp('out'), 'site.tgz'),
      media: false,
    })
    expect(loaded.problems).toEqual([])
    expect(loaded.set.manifest.media).toBe('omitted')
    expect(loaded.set.manifest.counts.media).toBe(1)
    expect(existsSync(join(dir, 'content', 'blobs'))).toBe(false)
    expect(result.media.omitted).toBe(true)
  })

  test('members travel sealed, and only when asked', async () => {
    const { h } = await site()
    await expect(
      exportSite(h.server.db, h.server.config, {
        out: join(temp('out'), 's.tgz'),
        withMembers: true,
      }),
    ).rejects.toThrow('passphrase')
    const { loaded } = await exported(h, {
      out: join(temp('out'), 'site.tgz'),
      withMembers: true,
      passphrase: PASSPHRASE,
    })
    expect(loaded.problems).toEqual([])
    const opened = openBundle(loaded, PASSPHRASE)
    expect(opened.people?.members.map((m) => m.email)).toEqual(['ada@example.com'])
  })

  test('sealed, the structure reads and the values and media files do not', async () => {
    const { h } = await site()
    const { loaded, dir } = await exported(h, {
      out: join(temp('out'), 'site.tgz'),
      sealContent: true,
      passphrase: PASSPHRASE,
    })
    expect(loaded.problems).toEqual([])
    expect(loaded.set.manifest.content).toBe('sealed')
    expect(loaded.set.sealed).toBe(true)
    // Content data only: the dictionary is a section, which travels readable.
    const glob = new Bun.Glob('content/{nodes,values,blobs}/**/*')
    for (const path of glob.scanSync({ cwd: dir, onlyFiles: true }))
      expect(readFileSync(join(dir, path)).toString('latin1'), path).not.toContain(
        'ada@example.com',
      )
    const opened = openBundle(loaded, PASSPHRASE)
    const home = opened.set.nodes.find((n) => n.kind === 'document')
    expect(home?.values.find((v) => v.property === 'contact')?.value).toBe('ada@example.com')
    const [key, file] = [...loaded.blobs][0] as [string, string]
    const sealedBytes = new Uint8Array(readFileSync(file))
    expect([...opened.openBlob(key, sealedBytes)]).toEqual([1, 2, 3, 4, 5])
  })

  test('anonymised, no address it held survives anywhere in the file', async () => {
    const { h } = await site()
    const { loaded, dir, result } = await exported(h, {
      out: join(temp('out'), 'site.tgz'),
      anonymise: true,
      withMembers: true,
      withUsers: true,
      passphrase: PASSPHRASE,
    })
    expect(loaded.problems).toEqual([])
    expect(result.people.users).toBe(0)
    const glob = new Bun.Glob('**/*')
    for (const path of glob.scanSync({ cwd: dir, onlyFiles: true }))
      expect(readFileSync(join(dir, path), 'utf8'), path).not.toContain('ada@example.com')
    const opened = openBundle(loaded, PASSPHRASE)
    expect(JSON.stringify(opened.people)).not.toContain('ada@example.com')
    expect(opened.people?.users).toEqual([])
    expect(opened.people?.members[0]?.passwordHash).toBeNull()
  })
})
