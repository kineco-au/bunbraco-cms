/**
 * The Settings section's log viewer: events logged through LogTape land in
 * Serilog's compact JSON, a file per day, and the viewer reads them back as
 * Umbraco's does — level counts, message templates, the log filtered by a
 * Serilog expression (or a text search when it is not one), saved searches.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LOG_SEARCHES } from '@bunbraco/data'
import {
  compileExpression,
  type LogEvent,
  logFileName,
  logFilter,
  logger,
  readClefLine,
  renderMessage,
  toClef,
} from '@bunbraco/server'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

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

const event = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  timestamp: '2026-09-27T10:00:00.000Z',
  level: 'Information',
  messageTemplate: 'Published {Name}',
  message: 'Published "Home"',
  exception: null,
  properties: { Name: 'Home', SourceContext: 'bunbraco.server', Duration: 1500, Tags: ['a', 'b'] },
  ...overrides,
})

describe('the filter language', () => {
  const matches = (expression: string, e: LogEvent = event()) => {
    const compiled = compileExpression(expression)
    if (!compiled) throw new Error(`did not compile: ${expression}`)
    return compiled(e)
  }

  test("every default saved search compiles, and Umbraco's own examples behave", () => {
    for (const search of DEFAULT_LOG_SEARCHES)
      expect([search.name, compileExpression(search.query) !== undefined]).toEqual([
        search.name,
        true,
      ])
    expect(matches("Not(@Level='Verbose') and Not(@Level='Debug')")).toBe(true)
    expect(
      matches("Not(@Level='Verbose') and Not(@Level='Debug')", event({ level: 'Debug' })),
    ).toBe(false)
    expect(matches('Has(@Exception)')).toBe(false)
    expect(matches('Has(@Exception)', event({ exception: 'Error: boom' }))).toBe(true)
    expect(matches('Has(Duration) and Duration > 1000')).toBe(true)
    expect(matches('Has(Duration) and Duration > 2000')).toBe(false)
    expect(matches("StartsWith(SourceContext, 'bunbraco')")).toBe(true)
    expect(matches("@MessageTemplate = 'Published {Name}'")).toBe(true)
    expect(matches("@Message like '%Home%'")).toBe(true)
    expect(matches("@Message like 'published%'")).toBe(false)
    expect(matches("@Message like 'published%' ci")).toBe(true)
    expect(matches("Tags[?] = 'b'")).toBe(true)
    expect(matches("Contains(Tags[?], 'z')")).toBe(false)
    expect(matches("Name in ['Home', 'About']")).toBe(true)
    expect(matches('Missing is null and Name is not null')).toBe(true)
    expect(matches("@Level = 'Information' or @Level = 'Error'")).toBe(true)
  })

  test('a missing property is undefined, which never matches, even negated', () => {
    expect(matches('Missing > 5')).toBe(false)
    expect(matches('not (Missing > 5)')).toBe(false)
    expect(matches('Has(Missing)')).toBe(false)
  })

  test('a plain word, or anything that does not compile, searches the rendered message', () => {
    expect(compileExpression('Has(')).toBeUndefined()
    expect(compileExpression('Unknown(Name)')).toBeUndefined()
    expect(logFilter('Home')(event())).toBe(true)
    expect(logFilter('home')(event())).toBe(false)
    expect(logFilter('Published "Home')(event())).toBe(true)
    expect(logFilter('')(event())).toBe(true)
    expect(logFilter("@Level = 'Error'")(event())).toBe(false)
  })
})

describe('the log files', () => {
  test("events are written as Serilog's compact JSON and read back rendered", () => {
    const clef = toClef({
      category: ['bunbraco', 'server'],
      level: 'error',
      message: [],
      rawMessage: 'Could not publish {name} after {tries} tries',
      timestamp: Date.parse('2026-09-27T10:00:00Z'),
      properties: { name: 'Home', tries: 3, error: new Error('boom') },
    })
    expect(clef).toMatchObject({
      '@t': '2026-09-27T10:00:00.000Z',
      '@mt': 'Could not publish {name} after {tries} tries',
      '@l': 'Error',
      name: 'Home',
      tries: 3,
      SourceContext: 'bunbraco.server',
    })
    expect(String(clef['@x'])).toContain('Error: boom')
    const read = readClefLine(JSON.stringify(clef))
    expect(read).toMatchObject({
      level: 'Error',
      message: 'Could not publish "Home" after 3 tries',
      exception: expect.stringContaining('boom'),
    })
    // Information carries no @l, as Serilog writes it
    const info = toClef({
      category: ['bunbraco'],
      level: 'info',
      message: [],
      rawMessage: 'Started',
      timestamp: 0,
      properties: {},
    })
    expect('@l' in info).toBe(false)
    expect(readClefLine(JSON.stringify(info))?.level).toBe('Information')
    expect(readClefLine('not json')).toBeUndefined()
    expect(logFileName(new Date('2026-09-27T23:59:59Z'), 'web 1')).toBe(
      'BunbracoTraceLog.web_1.20260927.json',
    )
  })

  test('message rendering follows Serilog: strings quoted, literal format, braces escaped', () => {
    expect(renderMessage('{Name} took {Ms}ms', { Name: 'x', Ms: 12 })).toBe('"x" took 12ms')
    expect(renderMessage('{Name:l} {@Obj} {Missing}', { Name: 'x', Obj: { a: 1 } })).toBe(
      'x {"a":1} {Missing}',
    )
    expect(renderMessage('{{literal}}', {})).toBe('{literal}')
  })
})

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'log-viewer-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  const logsDir = join(root, 'logs')
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      logsDir,
      logLevel: 'debug',
      development: true,
    },
  })
  open.push(h)
  return { h, logsDir }
}

const line = (e: Record<string, unknown>) => `${JSON.stringify(e)}\n`

describe('the log viewer API', () => {
  test('events the server logs appear, counted, grouped by template, filtered and paged', async () => {
    const { h, logsDir } = await site()
    const now = Date.now()
    const at = (msAgo: number) => new Date(now - msAgo).toISOString()
    // Earlier events, as another node would have written them today
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(
      join(logsDir, logFileName(new Date(now), 'other')),
      [
        line({
          '@t': at(60_000),
          '@mt': 'Published {Name}',
          Name: 'Home',
          SourceContext: 'bunbraco.content',
        }),
        line({
          '@t': at(50_000),
          '@mt': 'Published {Name}',
          Name: 'About',
          SourceContext: 'bunbraco.content',
        }),
        line({ '@t': at(40_000), '@mt': 'Slow request', '@l': 'Warning', Duration: 1500 }),
        line({ '@t': at(30_000), '@mt': 'Crashed', '@l': 'Error', '@x': 'Error: boom' }),
        line({ '@t': at(20_000), '@mt': 'Chatty', '@l': 'Verbose' }),
        'garbage that is not an event\n',
        // Two days ago: outside the default range of the last day
        line({ '@t': at(2 * 24 * 3600_000), '@mt': 'Long ago' }),
      ].join(''),
    )
    // And one the server logs itself, through LogTape
    logger('test').debug('Checked {Thing}', { Thing: 'logs' })

    expect((await h.call(`${V1}/log-viewer/validate-logs-size`)).status).toBe(200)
    expect(await h.json<unknown>(`${V1}/log-viewer/level-count`)).toEqual<unknown>({
      // Two publishes and the server's own start
      information: 3,
      debug: 1,
      warning: 1,
      error: 1,
      fatal: 0,
    })
    const templates = await h.json<{
      total: number
      items: Array<{ messageTemplate: string; count: number }>
    }>(`${V1}/log-viewer/message-template?skip=0&take=10`)
    expect(templates.items[0]).toEqual({ messageTemplate: 'Published {Name}', count: 2 })
    expect(templates.total).toBe(6)

    const log = await h.json<{
      total: number
      items: Array<{
        level: string
        renderedMessage: string
        exception: string | null
        properties: Array<{ name: string }>
      }>
    }>(`${V1}/log-viewer/log?skip=0&take=100`)
    expect(log.total).toBe(7)
    // Newest first
    expect(log.items[0]?.renderedMessage).toBe('Checked "logs"')
    expect(log.items.map((i) => i.renderedMessage)).not.toContain('Long ago')
    expect(log.items.find((i) => i.level === 'Error')?.exception).toBe('Error: boom')

    const query = (q: string) =>
      h.json<{ total: number; items: Array<{ renderedMessage: string }> }>(
        `${V1}/log-viewer/log?skip=0&take=100&${q}`,
      )
    expect(
      (
        await query(`filterExpression=${encodeURIComponent('Has(Duration) and Duration > 1000')}`)
      ).items.map((i) => i.renderedMessage),
    ).toEqual(['Slow request'])
    expect((await query('filterExpression=About')).items.map((i) => i.renderedMessage)).toEqual([
      'Published "About"',
    ])
    expect((await query('logLevel=Error&logLevel=Warning')).total).toBe(2)
    const oldest = await h.json<{ total: number; items: Array<{ renderedMessage: string }> }>(
      `${V1}/log-viewer/log?orderDirection=Ascending&skip=0&take=1`,
    )
    expect([oldest.total, oldest.items.map((i) => i.renderedMessage)]).toEqual([
      7,
      ['Published "Home"'],
    ])
    // A range reaches back further
    const since = encodeURIComponent(new Date(now - 3 * 24 * 3600_000).toISOString())
    const until = encodeURIComponent(new Date(now + 60_000).toISOString())
    expect((await query(`startDate=${since}&endDate=${until}`)).total).toBe(8)

    // An operation the backoffice asks for that is not built is logged, and the saved search finds it
    await h.call(`${V1}/health-check-group?skip=0&take=10`)
    const search = DEFAULT_LOG_SEARCHES.find((d) =>
      d.name.includes('specific log message template'),
    )
    const unbuilt = await query(`filterExpression=${encodeURIComponent(search?.query ?? '')}`)
    expect(unbuilt.items.map((i) => i.renderedMessage)).toEqual([
      'Operation "GetHealthCheckGroup" ("GET" "/umbraco/management/api/v1/health-check-group") is not implemented',
    ])

    expect(await h.json<unknown>(`${V1}/log-viewer/level?skip=0&take=10`)).toEqual<unknown>({
      total: 2,
      items: [
        { name: 'Global', level: 'Debug' },
        { name: 'BunbracoFile', level: 'Verbose' },
      ],
    })
  })

  test('files too large for the range are refused, as Umbraco caps them at 100 MB', async () => {
    const { h, logsDir } = await site()
    const file = join(logsDir, logFileName(new Date(), 'big'))
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(file, '')
    truncateSync(file, 101 * 1024 * 1024)
    const refused = await h.call(`${V1}/log-viewer/validate-logs-size`)
    expect(refused.status).toBe(400)
    expect((await refused.json()).title).toBe('Cancelled due to log file size')
    expect((await h.call(`${V1}/log-viewer/log?skip=0&take=10`)).status).toBe(400)
    expect((await h.call(`${V1}/log-viewer/level-count`)).status).toBe(400)
  })

  test('saved searches: the defaults, then create, read, refuse a duplicate, delete', async () => {
    const { h } = await site()
    const list = await h.json<{ total: number; items: Array<{ name: string; query: string }> }>(
      `${V1}/log-viewer/saved-search?skip=0&take=100`,
    )
    expect(list.items).toEqual([...DEFAULT_LOG_SEARCHES])
    const created = await h.post(`${V1}/log-viewer/saved-search`, {
      name: 'Errors',
      query: "@Level='Error'",
    })
    expect(created.status).toBe(201)
    expect(
      (await h.post(`${V1}/log-viewer/saved-search`, { name: 'Errors', query: 'x' })).status,
    ).toBe(400)
    expect(await h.json<unknown>(`${V1}/log-viewer/saved-search/Errors`)).toEqual<unknown>({
      name: 'Errors',
      query: "@Level='Error'",
    })
    // Names match exactly
    expect((await h.call(`${V1}/log-viewer/saved-search/errors`)).status).toBe(404)
    expect((await h.del(`${V1}/log-viewer/saved-search/Errors`)).status).toBe(200)
    expect((await h.del(`${V1}/log-viewer/saved-search/Errors`)).status).toBe(404)
  })
})
