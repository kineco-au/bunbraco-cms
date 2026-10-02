/**
 * The test containers, and the two bits of server config they depend on.
 *
 * The multi-node topology these used to cover — the renderer pool, the nginx
 * proxy, the shapes `docker:up` can start — moved to the enterprise
 * distribution along with the compose services that implement it. What is left
 * here is what the CMS's own suite needs: a database, a container per test
 * shape, and the port check a boot does first.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertPortAvailable, DEFAULTS, describeDatabase, portInUse } from '@bunbraco/server'

describe('the database a server names', () => {
  test('is the file itself on SQLite', () => {
    expect(describeDatabase({ dialect: 'sqlite', sqliteFile: '/site/bunbraco.sqlite' })).toBe(
      '/site/bunbraco.sqlite',
    )
  })

  test('is the host and database on Postgres, never the password', () => {
    const described = describeDatabase(
      { dialect: 'postgres', sqliteFile: '/site/bunbraco.sqlite' },
      'postgres://bunbraco:s3cret@db:5432/bunbraco',
    )
    expect(described).toBe('postgres db:5432/bunbraco')
    expect(described).not.toContain('s3cret')
  })

  test('falls back to the dialect when the URL is unparseable', () => {
    expect(describeDatabase({ dialect: 'postgres', sqliteFile: 'x.sqlite' }, 'not a url')).toBe(
      'postgres',
    )
  })

  test('falls back to the dialect when nothing configures a URL', () => {
    const previous = [Bun.env.BUNBRACO_POSTGRES_URL, Bun.env.DATABASE_URL]
    Bun.env.BUNBRACO_POSTGRES_URL = undefined
    Bun.env.DATABASE_URL = undefined
    try {
      expect(describeDatabase({ dialect: 'postgres', sqliteFile: 'x.sqlite' })).toBe('postgres')
    } finally {
      Bun.env.BUNBRACO_POSTGRES_URL = previous[0]
      Bun.env.DATABASE_URL = previous[1]
    }
  })
})

describe('the test containers', () => {
  const compose = readFileSync(join(import.meta.dir, '..', 'compose.yaml'), 'utf8')
  const scripts = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'))
    .scripts as Record<string, string>

  /** The compose services a script ends up running, following `bun run` chains. */
  const servicesOf = (name: string): string[] => {
    const body = scripts[name] ?? ''
    const services = [...body.matchAll(/docker compose run --rm (\S+)/g)].map((m) => m[1] as string)
    const delegated = [...body.matchAll(/bun run ([\w:]+)/g)].flatMap((m) =>
      servicesOf(m[1] as string),
    )
    return [...services, ...delegated]
  }

  test('every host test command has a docker: twin that runs a test service', () => {
    expect(servicesOf('docker:test')).toEqual(['cms-test-sqlite'])
    expect(servicesOf('docker:test:sqlite')).toEqual(['cms-test-sqlite'])
    expect(servicesOf('docker:test:postgres')).toEqual(['cms-test'])
    expect(servicesOf('docker:test:browser')).toEqual(['cms-test-browser'])
    // Both dialects, in the order `test:all` runs them.
    expect(servicesOf('docker:test:all')).toEqual(['cms-test-sqlite', 'cms-test'])
    // Nothing in the test family is left without one, `test:ci` excepted: it takes
    // its dialect from the environment, which in a container is the service.
    const hostCommands = Object.keys(scripts).filter(
      (name) => /^test(:|$)/.test(name) && name !== 'test:ci',
    )
    for (const host of hostCommands) expect(servicesOf(`docker:${host}`).length).toBeGreaterThan(0)
  })

  test('tears down the profile it starts, so a run leaves nothing behind', () => {
    // `docker compose down` acts on the active profile selection alone, so a
    // teardown naming none would leave a `run` container holding the database.
    for (const name of ['docker:down', 'docker:reset']) {
      expect(scripts[name]).toContain('--profile test')
      expect(scripts[name]).toContain('down')
      expect(scripts[name]).toContain('--remove-orphans')
    }
    // `reset` is the one that also discards the data.
    expect(scripts['docker:reset']).toContain('-v')
    expect(scripts['docker:down']).not.toContain('-v')
  })

  test('keeps the database out of the profile, so db:up can start it alone', () => {
    const db = compose.slice(compose.indexOf('\n  db:'), compose.indexOf('\n  cms-test-sqlite:'))
    expect(db).not.toContain('profiles:')
    // `test:postgres` depends on this: it runs `db:up` before the suite.
    expect(scripts['db:up']).toContain('--wait db')
    expect(scripts['test:postgres']).toContain('bun run db:up')
    // 5433 on the host, because 5432 is usually a local install.
    expect(db).toContain("- '5433:5432'")
  })

  test('carries no multi-node topology, which belongs to the enterprise repo', () => {
    // The renderer pool, the proxy and the shapes that start them moved out. A
    // service reappearing here would mean the split had quietly leaked back.
    for (const service of ['cms-api:', 'cms-web:', 'cms-web-pool:', 'cms-proxy:'])
      expect([service, compose.includes(service)]).toEqual([service, false])
    for (const profile of ['standalone', 'web-single', 'web-pool'])
      expect([profile, compose.includes(profile)]).toEqual([profile, false])
    // The only profile left is the one the test services sit behind.
    expect(compose.match(/profiles: \[/g)).toHaveLength(3)
  })

  test('the browser image pins the Playwright version the project installs', () => {
    const dockerfile = readFileSync(
      join(import.meta.dir, '..', 'docker', 'Dockerfile.browser'),
      'utf8',
    )
    const installed = JSON.parse(
      readFileSync(
        join(import.meta.dir, '..', 'node_modules', '@playwright', 'test', 'package.json'),
        'utf8',
      ),
    ).version as string
    // A mismatch makes Playwright reject the browsers the image ships, with an
    // error that points at neither file.
    expect(dockerfile).toContain(`FROM mcr.microsoft.com/playwright:v${installed}-`)
  })

  test('the browser service brings its own browsers, node_modules and channel', () => {
    const browser = compose.slice(compose.indexOf('cms-test-browser:'))
    expect(browser).toContain('dockerfile: Dockerfile.browser')
    // Debian image against the CMS image's Alpine: one install cannot serve both.
    expect(browser).toContain('browser_node_modules:/app/node_modules')
    // Empty selects Playwright's Chromium; Chrome has no Linux arm64 build.
    expect(browser).toContain("BUNBRACO_BROWSER_CHANNEL: ''")
  })

  test('the SQLite test service declares no database, so it starts no Postgres', () => {
    const sqlite = compose.slice(
      compose.indexOf('cms-test-sqlite:'),
      compose.indexOf('  cms-test:'),
    )
    expect(sqlite).toContain('BUNBRACO_DB: sqlite')
    expect(sqlite).not.toContain('depends_on')
    // Both are behind the profile, so `docker compose up` never starts them.
    expect(sqlite).toContain("profiles: ['test']")
  })

  test('both test services take the environment a host run sets', () => {
    for (const key of [
      'BUNBRACO_SQLITE_FILE',
      'BUNBRACO_ADMIN_PASSWORD',
      'BUNBRACO_VIEWS_DIR',
      'BUNBRACO_MEDIA_DIR',
      'BUNBRACO_LOGS_DIR',
      'BUNBRACO_LOG_TO_CONSOLE',
    ])
      expect(scripts['test:sqlite']).toContain(key)
    // One anchor supplies them to every test service rather than copies drifting.
    const services = compose.match(/^ {2}cms-test[\w-]*:$/gm) ?? []
    expect(services.length).toBeGreaterThanOrEqual(3)
    expect(compose.match(/<<: \*test-environment/g)).toHaveLength(services.length)
  })
})

describe('the port a server is about to bind', () => {
  /** An ephemeral port, and the server holding it. */
  const hold = () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('held') })
    return { port: server.port as number, stop: () => server.stop(true) }
  }

  test('is reported free when nothing holds it, and taken when something does', async () => {
    const held = hold()
    try {
      expect(await portInUse(held.port)).toBe(true)
      await expect(assertPortAvailable(held.port)).rejects.toThrow(
        `Port ${held.port} is already in use`,
      )
    } finally {
      held.stop()
    }
    // The same port once its holder has gone.
    expect(await portInUse(held.port)).toBe(false)
    await expect(assertPortAvailable(held.port)).resolves.toBeUndefined()
  })

  test('names the container stack, which is the usual reason it is taken', async () => {
    const held = hold()
    try {
      const error = (await assertPortAvailable(held.port).catch((e: unknown) => e)) as Error
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain('docker:down')
      expect(error.message).toContain('PORT')
    } finally {
      held.stop()
    }
  })

  test('defaults to the port the backoffice builds its own links from', () => {
    expect(DEFAULTS.port).toBe(8080)
  })
})
