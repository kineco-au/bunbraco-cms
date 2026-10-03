/**
 * Importing an Umbraco site, through the real CLI, the way somebody does it:
 * `import umbraco report`, then `import umbraco apply`, then `bunbraco start`
 * in the directory it wrote.
 *
 * The site that boots is checked against the source: every URL the Umbraco site
 * served has to answer here. That is the importer's exit criterion, and nothing
 * short of a real boot proves it.
 *
 * Named `*.integration.ts`, so `bun test` does not collect it: it spawns
 * processes and boots a server. `bun run test:integration` runs it, and CI does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEMO_STORE } from '../support/umbraco-import.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'packages/cli/bin/bunbraco.ts')
const PIXEL = join(ROOT, 'tests/fixtures/pixel.png')

interface Run {
  code: number
  out: string
}

describe('importing an Umbraco site, end to end through the CLI', () => {
  let dir: string
  let site: string
  let applied: Run
  let server: { url: string; banner: string; stop(): Promise<void> } | undefined

  function environment(): Record<string, string> {
    const inherited = { ...(process.env as Record<string, string>) }
    for (const name of [
      'BUNBRACO_SQLITE_FILE',
      'BUNBRACO_VIEWS_DIR',
      'BUNBRACO_SCHEMA_DIR',
      'BUNBRACO_MEDIA_DIR',
      'BUNBRACO_CSS_DIR',
      'BUNBRACO_SCRIPTS_DIR',
      'BUNBRACO_SITE_NAME',
    ])
      delete inherited[name]
    return {
      ...inherited,
      BUNBRACO_DB: 'sqlite',
      BUNBRACO_LOGS_DIR: join(dir, 'logs'),
      BUNBRACO_LOG_TO_CONSOLE: 'false',
      BUNBRACO_ADMIN_PASSWORD: 'integration-password',
    }
  }

  async function cli(cwd: string, ...args: string[]): Promise<Run> {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      cwd,
      env: environment(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 120_000)
    try {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { code: await proc.exited, out: `${out}${err}` }
    } finally {
      clearTimeout(timer)
    }
  }

  beforeAll(async () => {
    mkdirSync(join(ROOT, 'output'), { recursive: true })
    dir = mkdtempSync(join(ROOT, 'output', 'import-site-'))
    site = join(dir, 'imported')

    // What a backup's files look like: one Razor view, one media file, one stylesheet.
    const web = join(dir, 'backup', 'Store.Web')
    const put = (path: string, content: string | Uint8Array) => {
      mkdirSync(join(web, path, '..'), { recursive: true })
      writeFileSync(join(web, path), content)
    }
    put('Views/HomePage.cshtml', '@{ Layout = "Page.cshtml"; }\n<h1>@Model.Name</h1>\n')
    put('wwwroot/media/qvzdvqf4/whiterthanwhite.jpg', readFileSync(PIXEL))
    put('wwwroot/css/site.css', 'body { margin: 0 }\n')

    applied = await cli(
      dir,
      'import',
      'umbraco',
      'apply',
      DEMO_STORE,
      '--site',
      join(dir, 'backup'),
      '--out',
      site,
      '--name',
      'Tea Shop',
    )
    if (applied.code !== 0) return

    const start = (
      JSON.parse(readFileSync(join(site, 'package.json'), 'utf8')) as {
        scripts: { start: string }
      }
    ).scripts.start
    const proc = Bun.spawn(['bun', CLI, ...start.split(' ').slice(1)], {
      cwd: site,
      env: { ...environment(), NODE_ENV: 'production', PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 120_000)
    const decoder = new TextDecoder()
    let banner = ''
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      banner += decoder.decode(chunk)
      if (banner.includes('└─')) break
    }
    clearTimeout(timer)
    const url = /site\s+(http:\/\/\S+)/.exec(banner)?.[1] ?? ''
    if (!url) {
      const error = await new Response(proc.stderr).text()
      await proc.exited
      throw new Error(`The imported site did not start:\n${banner}${error}`)
    }
    server = {
      url,
      banner,
      async stop() {
        proc.kill()
        await proc.exited
      },
    }
  }, 300_000)

  afterAll(async () => {
    await server?.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('report reads the backup, prints what it found and writes nothing unless asked', async () => {
    const run = await cli(dir, 'import', 'umbraco', 'report', DEMO_STORE)
    expect(run.code, run.out).toBe(0)
    expect(run.out).toContain('Umbraco 17.0.0, from a .bacpac')
    expect(run.out).toContain('Cannot be migrated:')
    expect(run.out).toContain('Package: Umbraco Commerce (52)')
    expect(run.out).toContain('Razor templates to rewrite as TSX (20)')
    expect(existsSync(join(dir, 'report.md'))).toBe(false)

    const json = await cli(dir, 'import', 'umbraco', 'report', DEMO_STORE, '--json')
    expect(JSON.parse(json.out).ready).toBe(true)

    const written = await cli(dir, 'import', 'umbraco', 'report', DEMO_STORE, '--out', 'reports')
    expect(written.code).toBe(0)
    expect(readFileSync(join(dir, 'reports', 'report.md'), 'utf8')).toStartWith(
      '# Umbraco import report',
    )
  }, 120_000)

  test('a backup it cannot read, or a missing argument, is refused with the reason', async () => {
    const missing = await cli(dir, 'import', 'umbraco', 'report', 'nothing.bacpac')
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('No file at nothing.bacpac')

    const noOut = await cli(dir, 'import', 'umbraco', 'apply', DEMO_STORE)
    expect(noOut.code).toBe(1)
    expect(noOut.out).toContain('needs --out <dir>')

    const noBackup = await cli(dir, 'import', 'umbraco', 'report', '--out', 'somewhere')
    expect(noBackup.code).toBe(1)
    expect(noBackup.out).toContain('needs the backup')
  }, 120_000)

  test('apply writes a whole site, and says what to do next', () => {
    expect(applied.code, applied.out).toBe(0)
    expect(applied.out).toContain('bun start')
    expect(applied.out).toContain('bunbraco dictionary import import/dictionary.udt')
    for (const file of [
      'package.json',
      'bunbraco.config.ts',
      'server.ts',
      'schema/schema.toml',
      'schema/document-types/home-page.toml',
      'schema/languages.toml',
      'Views/HomePage.tsx',
      'bundles/umbraco-import/bundle.json',
      'media/qvzdvqf4/whiterthanwhite.jpg',
      'css/site.css',
      'import/report.md',
      'import/report.json',
      'import/urls.txt',
      'import/dictionary.udt',
      'import/razor/Views/HomePage.cshtml',
    ])
      expect(existsSync(join(site, file)), file).toBe(true)

    expect(readFileSync(join(site, 'bunbraco.config.ts'), 'utf8')).toContain("siteName: 'Tea Shop'")
    // 192 of the 193 media files were not in the backup, so the import is told to allow that.
    expect(
      (
        JSON.parse(readFileSync(join(site, 'package.json'), 'utf8')) as {
          scripts: { start: string }
        }
      ).scripts.start,
    ).toBe('bunbraco start --bundle bundles/umbraco-import --publish --allow-missing-blobs')
  })

  test('apply refuses to write into a directory that already holds something', async () => {
    const again = await cli(dir, 'import', 'umbraco', 'apply', DEMO_STORE, '--out', site)
    expect(again.code).toBe(1)
    expect(again.out).toContain('is not empty')
  }, 120_000)

  test('the schema it wrote is valid, and every view compiles', async () => {
    const schema = await cli(site, 'schema', 'check', '--static')
    expect(schema.code, schema.out).toBe(0)
    expect(schema.out).toContain('25 document type(s)')
    const views = await cli(site, 'views', 'check')
    expect(views.code, views.out).toBe(0)
    expect(views.out).toContain('20 template(s)')
  }, 120_000)

  test('the first boot imports the bundle and publishes what was live', () => {
    expect(server?.banner).toContain('436 created, 0 updated, 181 published')
  })

  test('every URL the Umbraco site served answers here', async () => {
    const urls = readFileSync(join(site, 'import', 'urls.txt'), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(urls.length).toBe(78)
    const failed: string[] = []
    for (const path of urls) {
      const response = await fetch(new URL(path, server?.url))
      if (response.status !== 200) failed.push(`${response.status} ${path}`)
      await response.arrayBuffer()
    }
    expect(failed).toEqual([])
  }, 120_000)

  test('a page renders through the layout chain its Razor template had', async () => {
    const html = await (await fetch(new URL('/', server?.url))).text()
    // Layout → Page → HomePage, each a stub: the document, a wrapper, the page.
    expect(html).toContain('<title>Home</title>')
    expect(html).toContain('<body><div><main><h1>Home</h1></main></div></body>')
  })

  test('a media file that was in the backup is served from where its value points', async () => {
    const response = await fetch(new URL('/media/qvzdvqf4/whiterthanwhite.jpg', server?.url))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(readFileSync(PIXEL)),
    )
  })

  test('the dictionary it wrote imports', async () => {
    await server?.stop()
    server = undefined
    const run = await cli(site, 'dictionary', 'import', 'import/dictionary.udt')
    expect(run.code, run.out).toBe(0)
    expect(run.out).toContain('imported 2 item(s)')
  }, 120_000)
})
