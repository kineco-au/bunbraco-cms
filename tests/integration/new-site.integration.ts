/**
 * Creating a site, through the real CLI, the way somebody actually does it.
 *
 * `bunbraco init`, then `bunbraco start`, in a directory of their own — no
 * fixtures written by the test, because the point is to prove that what `init`
 * writes is what boots. Three sites: one scaffolded bare, one from each starter
 * template. Everything is asserted over HTTP against a real boot, including the
 * images, because a template that ships media is only correct if the bytes land
 * where the bundle says they are.
 *
 * Named `*.integration.ts`, so `bun test` does not collect it: it spawns
 * processes and boots servers. `bun run test:integration` runs it, and CI does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'packages/cli/bin/bunbraco.ts')
const TEMPLATES = join(ROOT, 'packages/cli/templates')

interface Run {
  code: number
  out: string
}

interface Serving {
  url: string
  banner: string
  stop(): Promise<void>
}

describe('creating a site, end to end through the CLI', () => {
  let dir: string
  const running: Serving[] = []
  /** What `init` printed for each site, asserted below rather than where it ran. */
  const scaffolded: Record<string, Run> = {}
  let bare: Serving
  let demo: Serving

  const siteDir = (name: string) => join(dir, name)

  /**
   * A scaffolded site is meant to work on its own defaults — its own `Views/`,
   * its own `media/`, its own SQLite file beside `bunbraco.config.ts`. The test
   * environment points those at shared directories, so they are cleared here or
   * this suite would prove a site works only where the harness aims it.
   */
  function environment(site: string): Record<string, string> {
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
      BUNBRACO_LOGS_DIR: join(dir, 'logs', site),
      BUNBRACO_LOG_TO_CONSOLE: 'false',
      BUNBRACO_ADMIN_PASSWORD: 'integration-password',
    }
  }

  /**
   * Everything a process printed, and its exit code. A command that has not
   * finished in time is killed: a wrong assumption here otherwise hangs until
   * the suite's own timeout, with nothing to read.
   */
  async function collect(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<Run> {
    const timer = setTimeout(() => proc.kill(), 60_000)
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

  /** A command in a site's own directory, as somebody standing in it would run it. */
  function cli(site: string, ...args: string[]): Promise<Run> {
    return collect(
      Bun.spawn(['bun', CLI, ...args], {
        cwd: siteDir(site),
        env: environment(site),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
  }

  /** `bunbraco init` in a new directory, with whatever flags. */
  async function scaffold(site: string, ...args: string[]): Promise<Run> {
    mkdirSync(siteDir(site), { recursive: true })
    const run = await cli(site, 'init', ...args)
    scaffolded[site] = run
    return run
  }

  /** Boots a site as a deploy does, and waits for the banner to name its URL. */
  async function serve(site: string, ...args: string[]): Promise<Serving> {
    const proc = Bun.spawn(['bun', CLI, 'start', ...args], {
      cwd: siteDir(site),
      env: { ...environment(site), NODE_ENV: 'production', PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 60_000)
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
      throw new Error(`${site} did not start:\n${banner}${error}`)
    }
    const server: Serving = {
      url,
      banner,
      async stop() {
        proc.kill()
        await proc.exited
        const index = running.indexOf(server)
        if (index >= 0) running.splice(index, 1)
      },
    }
    running.push(server)
    return server
  }

  const get = (server: Serving, path: string) => fetch(new URL(path, server.url))
  const page = async (server: Serving, path: string): Promise<string> => {
    const response = await get(server, path)
    expect(response.status, `${path} on ${server.url}`).toBe(200)
    return await response.text()
  }
  const json = (site: string, file: string) =>
    JSON.parse(readFileSync(join(siteDir(site), file), 'utf8')) as Record<string, unknown>

  beforeAll(async () => {
    // `output/` is gitignored, so a fresh checkout has not got one.
    mkdirSync(join(ROOT, 'output'), { recursive: true })
    dir = mkdtempSync(join(ROOT, 'output', 'new-site-'))

    const bareInit = await scaffold('bare', '--name', 'Bare Site')
    expect(bareInit.code, bareInit.out).toBe(0)
    const basicInit = await scaffold('basic', '--name', 'Basic Site', '--template', 'basic')
    expect(basicInit.code, basicInit.out).toBe(0)
    const demoInit = await scaffold(
      'demo',
      '--name',
      'Harbourstone Distillery',
      '--template',
      'demo/harbourstone',
    )
    expect(demoInit.code, demoInit.out).toBe(0)
    const postgresInit = await scaffold('postgres', '--name', 'Postgres Site', '--postgres')
    expect(postgresInit.code, postgresInit.out).toBe(0)

    bare = await serve('bare')
    demo = await serve('demo', '--bundle', 'bundles/demo-harbourstone', '--publish')
  }, 240_000)

  afterAll(async () => {
    for (const server of [...running]) await server.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('scaffolds a site that is a package, a config, a server and its schema', () => {
    const out = scaffolded.bare?.out ?? ''
    for (const file of [
      'package.json',
      'bunbraco.config.ts',
      'server.ts',
      'tsconfig.json',
      'schema/schema.toml',
      '.gitignore',
    ])
      expect(out).toContain(`created  ${file}`)
    // The media types a site owns as files, rather than inheriting silently.
    expect(out).toContain('schema/media-types/umbraco-media-video.toml')

    const manifest = json('bare', 'package.json')
    expect(manifest.name).toBe('bare-site')
    expect(manifest.type).toBe('module')
    // Pinned, so `bun install` resolves the version that scaffolded the site.
    expect((manifest.dependencies as Record<string, string>).bunbraco).toMatch(/^\^\d+\.\d+\.\d+$/)
    // No template, so nothing to import on boot.
    expect((manifest.scripts as Record<string, string>).start).toBe('bunbraco start')
    expect(readFileSync(join(siteDir('bare'), 'bunbraco.config.ts'), 'utf8')).toContain(
      "siteName: 'Bare Site'",
    )
    expect(existsSync(join(siteDir('bare'), '.env'))).toBe(false)
  })

  test('--postgres writes the environment a Postgres site needs, and nothing else changes', () => {
    const env = readFileSync(join(siteDir('postgres'), '.env'), 'utf8')
    expect(env).toContain('BUNBRACO_DB=postgres')
    expect(env).toContain('BUNBRACO_POSTGRES_URL=')
    // The backup rule, where it is first needed rather than in a stack trace.
    expect(env).toContain('BUNBRACO_PG_DUMP')
    expect(readFileSync(join(siteDir('postgres'), '.gitignore'), 'utf8')).toContain('.env')
  })

  test('lists the starter templates, and refuses one it does not have', async () => {
    const list = await cli('bare', 'init', '--template', 'list')
    expect(list.code, list.out).toBe(0)
    expect(list.out).toContain('basic')
    expect(list.out).toContain('demo/harbourstone')

    const unknown = await cli('bare', 'init', '--template', 'nope')
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain('No template "nope"')
    expect(unknown.out).toContain('--template list')
  })

  test('a site with nothing published says so, and still answers 404', async () => {
    const response = await get(bare, '/')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Nothing is published yet')
    expect(html).toContain('Bare Site')
    expect(html).toContain('/bunbraco')
  })

  test('a path that is not a page on a site that has pages is still a bare 404', async () => {
    const response = await get(demo, '/no-such-page')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toBe('Not Found')
  })

  test('the basic template boots and serves its page, and a second boot imports nothing', async () => {
    const manifest = json('basic', 'package.json')
    const start = (manifest.scripts as Record<string, string>).start as string
    expect(start).toBe('bunbraco start --bundle bundles/basic --publish')

    // Exactly what the scaffolded script would run.
    const first = await serve('basic', ...start.split(' ').slice(1))
    expect(first.banner).toMatch(/bundle\s+\S+: 1 created, 0 updated, 1 published/)
    const html = await page(first, '/')
    expect(html).toContain('A new bunbraco site')
    expect(html).toContain('schema/document-types/home-page.toml')
    await first.stop()

    const second = await serve('basic', ...start.split(' ').slice(1))
    expect(second.banner).toContain('already imported')
    expect(second.banner).not.toContain('1 created')
    // And the content is still there, imported once.
    expect(await page(second, '/')).toContain('A new bunbraco site')
    await second.stop()

    const runs = await cli('basic', 'content', 'runs')
    expect(runs.code, runs.out).toBe(0)
    expect(runs.out.trim().split('\n').filter(Boolean)).toHaveLength(1)
    expect(runs.out).toContain('import')
    expect(runs.out).toContain('applied')
  }, 120_000)

  test('the demo template serves its home page, in the order its author put it in', async () => {
    const html = await page(demo, '/')
    expect(html).toContain('Harbourstone Distillery')
    expect(html).toContain('Coastal single malt, matured within sight of the water')
    // Sort order travels with the bundle: without that this arrives shuffled.
    const nav = /<nav>(.*?)<\/nav>/s.exec(html)?.[1] ?? ''
    expect([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1])).toEqual([
      'Our Whisky',
      'The Distillery',
      'Visit',
      'Journal',
      'Contact',
    ])
    // Each section card carries its own summary, so the type travelled whole.
    expect(html).toContain('Tours at 11.00 and 14.00')
  })

  test('its elements travel too: a bottling renders the tasting notes it picked', async () => {
    const html = await page(demo, '/our-whisky/harbourstone-12')
    expect(html).toContain('Harbourstone 12 Year Old')
    expect(html).toContain('12 years in cask')
    for (const aspect of ['Nose', 'Palate', 'Finish']) expect(html).toContain(`<dt>${aspect}</dt>`)
    expect(html).toContain('salt off the harbour wall')
    // The picked order, not the order the elements were created in.
    expect(html.indexOf('<dt>Nose</dt>')).toBeLessThan(html.indexOf('<dt>Palate</dt>'))
    expect(html.indexOf('<dt>Palate</dt>')).toBeLessThan(html.indexOf('<dt>Finish</dt>'))
  })

  test('its media travels: the file the template shipped is what the site serves', async () => {
    const html = await page(demo, '/')
    const src = /<img src="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&') as string
    expect(src).toStartWith('/media/')

    // The bundle carried the bytes and the boot placed them in this site's
    // store, so what it serves is the file the template shipped.
    const shipped = join(TEMPLATES, 'demo/harbourstone/bundle/blobs/2462ad2e/harbour-at-dawn.jpg')
    const landed = join(siteDir('demo'), 'media', '2462ad2e', 'harbour-at-dawn.jpg')
    expect(readFileSync(landed)).toEqual(readFileSync(shipped))

    // The original, and a crop computed from it: a raster the image pipeline
    // can actually work on, which is the reason the template ships one.
    const original = await get(demo, '/media/2462ad2e/harbour-at-dawn.jpg')
    expect(original.status).toBe(200)
    expect(original.headers.get('content-type')).toContain('image/jpeg')

    const crop = await get(demo, src)
    expect(crop.status).toBe(200)
    expect(crop.headers.get('content-type')).toContain('image/')
    expect((await crop.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  test('the demo site is a working site, not a fixture: every page in the nav answers', async () => {
    for (const path of ['/our-whisky', '/the-distillery', '/visit', '/journal', '/contact']) {
      const response = await get(demo, path)
      expect(response.status, path).toBe(200)
    }
    const journal = await page(demo, '/journal')
    expect(journal).toContain('Filling the first cask of 2026')
    // A date property, rendered as prose rather than as a timestamp.
    expect(journal).toContain('February 2026')
  })

  test('scaffolds a type and a property, and applies them to the site it is in', async () => {
    // Its own site, rather than one of the sites a server is already serving:
    // this writes schema and syncs it, and nothing here needs an audience.
    const scaffolded = await scaffold('scaffold', '--name', 'Scaffold Test')
    expect(scaffolded.code, scaffolded.out).toBe(0)

    // No types at all, which is where `schema new` earns its place: there is
    // nothing in the directory to copy from.
    const created = await cli('scaffold', 'schema', 'new', 'document-type', 'note', '--at-root')
    expect(created.code, created.out).toBe(0)
    expect(created.out).toContain('schema/document-types/note.toml')
    expect(created.out).toContain('Views/note.tsx')
    expect(created.out).toContain('schema   applied')
    expect(existsSync(join(siteDir('scaffold'), 'Views', 'note.tsx'))).toBe(true)

    const added = await cli(
      'scaffold',
      'schema',
      'add-property',
      'note',
      'summary',
      '--type',
      'textarea',
      '--mandatory',
    )
    expect(added.code, added.out).toBe(0)
    expect(added.out).toContain('in tab "Content"')
    expect(added.out).toContain('schema   applied')

    // The file it wrote is one the static check accepts, which is the gate a
    // pull request runs, and `generate` types the property for a view.
    const check = await cli('scaffold', 'schema', 'check', '--static')
    expect(check.code, check.out).toBe(0)
    const generated = await cli('scaffold', 'generate')
    expect(generated.code, generated.out).toBe(0)
    expect(
      readFileSync(join(siteDir('scaffold'), 'schema', 'content-types.d.ts'), 'utf8'),
    ).toContain('summary')

    // And it will not quietly write the same property twice.
    const again = await cli(
      'scaffold',
      'schema',
      'add-property',
      'note',
      'summary',
      '--type',
      'textarea',
    )
    expect(again.code).toBe(1)
    expect(again.out).toContain('already has a property')
  }, 60_000)

  test('checks the views it shipped, and lists what is in Views/', async () => {
    const listed = await cli('demo', 'views', 'list')
    expect(listed.code, listed.out).toBe(0)
    expect(listed.out).toContain('template  Views/homePage.tsx')
    expect(listed.out).toContain('← homePage')
    // Only the top level is a template; the shared layout is a component.
    expect(listed.out).toContain('component Views/components/layout.tsx')

    const checked = await cli('demo', 'views', 'check')
    expect(checked.code, checked.out).toBe(0)
    expect(checked.out).toContain('template(s)')
    // No typescript in a site nothing has installed into, said rather than skipped.
    expect(checked.out).toContain('bun add -d typescript')
  }, 60_000)

  test('catches a view that would be a 500, before a visitor finds it', async () => {
    const view = join(siteDir('demo'), 'Views', 'broken.tsx')
    writeFileSync(view, 'export default function Broken() {\n  return <p>{oops\n}\n')
    try {
      const checked = await cli('demo', 'views', 'check')
      expect(checked.code).toBe(1)
      expect(checked.out).toMatch(/Views\/broken\.tsx:\d+/)
    } finally {
      rmSync(view, { force: true })
    }

    // And a template a type declares with no file is the other half of it.
    const moved = join(siteDir('demo'), 'Views', 'journal.tsx')
    const kept = readFileSync(moved, 'utf8')
    rmSync(moved)
    try {
      const checked = await cli('demo', 'views', 'check')
      expect(checked.code).toBe(1)
      expect(checked.out).toContain('declares the template "journal"')
    } finally {
      writeFileSync(moved, kept)
    }
  }, 60_000)

  test('writes a partial, a stylesheet and a script where each belongs', async () => {
    const partial = await cli('demo', 'views', 'new', 'header', '--partial')
    expect(partial.code, partial.out).toBe(0)
    expect(partial.out).toContain('Views/Partials/header.tsx')
    expect(existsSync(join(siteDir('demo'), 'Views', 'Partials', 'header.tsx'))).toBe(true)

    const stylesheet = await cli('demo', 'assets', 'new', 'stylesheet', 'print.css')
    expect(stylesheet.code, stylesheet.out).toBe(0)
    const script = await cli('demo', 'assets', 'new', 'script', 'menu')
    expect(script.code, script.out).toBe(0)

    const assets = await cli('demo', 'assets', 'list')
    expect(assets.out).toContain('stylesheet css/print.css')
    // The template's own stylesheet is there too.
    expect(assets.out).toContain('stylesheet css/site.css')
    expect(assets.out).toContain('script     scripts/menu.js')

    // Written once: a second attempt refuses rather than overwriting.
    const again = await cli('demo', 'assets', 'new', 'stylesheet', 'print.css')
    expect(again.code).toBe(1)
    expect(again.out).toContain('already exists')

    // The partial counts as a partial, not as a template nothing declares.
    const listed = await cli('demo', 'views', 'list')
    expect(listed.out).toContain('partial   Views/Partials/header.tsx')
    // And the site still checks clean with them there.
    const checked = await cli('demo', 'views', 'check')
    expect(checked.code, checked.out).toBe(0)
  }, 60_000)

  test('says what an environment is before it has ever been started', async () => {
    const fresh = await scaffold('status', '--name', 'Status Test')
    expect(fresh.code, fresh.out).toBe(0)

    const status = await cli('status', 'status')
    // Nothing is installed yet, so it says so and exits non-zero: a deploy step
    // can use this as a gate.
    expect(status.code).toBe(1)
    expect(status.out).toContain('Status Test')
    expect(status.out).toContain('no database yet')
    expect(status.out).toContain('bunbraco')

    // And it did not install anything by asking.
    expect(existsSync(join(siteDir('status'), 'bunbraco.sqlite'))).toBe(false)
  }, 60_000)

  test('and what it is once it is running, in both forms', async () => {
    const status = await cli('demo', 'status')
    expect(status.code, status.out).toBe(0)
    expect(status.out).toContain('Harbourstone Distillery')
    expect(status.out).toContain('up to date')
    expect(status.out).toContain('no migration pending')
    // The demo's own content, counted.
    expect(status.out).toMatch(/content\s+11 document\(s\), 5 media/)

    const json = await cli('demo', 'status', '--json')
    expect(json.code, json.out).toBe(0)
    const report = JSON.parse(json.out) as {
      database: { installed: boolean }
      schema: { files: string; database: { version: string } }
      content: { documents: number; media: number }
      versions: { bunbraco: string }
    }
    expect(report.database.installed).toBe(true)
    expect(report.schema.files).toBe(report.schema.database.version)
    expect(report.content.documents).toBe(11)
    expect(report.content.media).toBe(5)
    expect(report.versions.bunbraco).toMatch(/^\d+\.\d+\.\d+$/)
  }, 60_000)

  test('and its schema is valid on its own terms, as a pull request would check', async () => {
    const check = await cli('demo', 'schema', 'check', '--static')
    expect(check.code, check.out).toBe(0)
    expect(check.out).toContain('valid')
  })

  /**
   * The reset reaches the database directly rather than booting a server, so it
   * works against a site that is already running — which is the state somebody
   * locked out of their own backoffice is actually in. Asserted by signing in
   * with what it printed, on the server that was up the whole time.
   */
  test('resets the admin password of a site that is already serving', async () => {
    const site = await serve('basic')
    try {
      const reset = await cli('basic', 'admin', 'reset-password')
      expect(reset.code, reset.out).toBe(0)
      const [login, password] = reset.out.trim().split('\n')
      expect(login).toContain('@')
      expect(password?.length).toBeGreaterThan(8)

      const response = await fetch(
        new URL('/umbraco/management/api/v1/security/back-office/login', site.url),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: login, password }),
        },
      )
      expect(response.status, await response.text()).toBe(200)
    } finally {
      await site.stop()
    }
  }, 120_000)
})
