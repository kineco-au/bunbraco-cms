/**
 * The log viewer over the site's log files, as Umbraco's reads Serilog's: the
 * files of each UTC day in the range (`*yyyyMMdd*.json`), one CLEF event per
 * line (a line that is not one is skipped), and the entries whose time falls
 * in the range, both ends included.
 */
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogEntry, LogLevelName, LogRange, LogViewerPort } from '@bunbraco/api-management'
import { type Db, LogSearchRepository } from '@bunbraco/data'
import type { BunbracoConfig } from './config.ts'
import { type LogEvent, logFilter } from './log-expressions.ts'
import { SERILOG_LEVELS } from './logging.ts'

/** Umbraco's `FileSizeCap`: ranges whose files come to more are refused. */
export const LOG_SIZE_CAP_MB = 100

const DAY = 24 * 60 * 60 * 1000

/** Umbraco's default: when either end is missing, the last day. */
function resolveRange(range: LogRange, now = new Date()): { start: Date; end: Date } {
  if (!range.start || !range.end) return { start: new Date(now.getTime() - DAY), end: now }
  return { start: range.start, end: range.end }
}

const dayStamp = (date: Date) => date.toISOString().slice(0, 10).replaceAll('-', '')

async function filesFor(dir: string, range: { start: Date; end: Date }): Promise<string[]> {
  if (!existsSync(dir)) return []
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
  const days = new Set<string>()
  for (
    let day = Date.UTC(
      range.start.getUTCFullYear(),
      range.start.getUTCMonth(),
      range.start.getUTCDate(),
    );
    day <= range.end.getTime();
    day += DAY
  )
    days.add(dayStamp(new Date(day)))
  return names.filter((n) => [...days].some((d) => n.includes(d))).map((n) => join(dir, n))
}

/** Serilog's rendering of a property value in a message: strings quoted, the rest as written. */
function renderProperty(value: unknown, format: string | undefined): string {
  if (typeof value === 'string') return format === 'l' ? value : `"${value}"`
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** A message template with its properties filled in, as Serilog's `RenderMessage` does. */
export function renderMessage(template: string, properties: Record<string, unknown>): string {
  return template.replace(
    /\{\{|\}\}|\{([@$]?)([A-Za-z0-9_]+)(?:,[^:}]*)?(?::([^}]*))?\}/g,
    (whole, _hint: string | undefined, name: string | undefined, format: string | undefined) => {
      if (whole === '{{') return '{'
      if (whole === '}}') return '}'
      if (!name || !(name in properties)) return whole
      return renderProperty(properties[name], format)
    },
  )
}

const LEVEL_NAMES = new Set(Object.values(SERILOG_LEVELS))

/** One CLEF line as an event the viewer shows and filters; undefined when it is not one. */
export function readClefLine(line: string): (LogEvent & { level: LogLevelName }) | undefined {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || typeof raw['@t'] !== 'string') return undefined
  const properties: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(raw))
    if (!name.startsWith('@')) properties[name] = value
  const template =
    typeof raw['@mt'] === 'string' ? raw['@mt'] : typeof raw['@m'] === 'string' ? raw['@m'] : ''
  const level =
    typeof raw['@l'] === 'string' && LEVEL_NAMES.has(raw['@l']) ? raw['@l'] : 'Information'
  return {
    timestamp: raw['@t'],
    level: level as LogLevelName,
    messageTemplate: template,
    message: typeof raw['@m'] === 'string' ? raw['@m'] : renderMessage(template, properties),
    exception: typeof raw['@x'] === 'string' ? raw['@x'] : null,
    properties,
  }
}

async function readEvents(dir: string, range: { start: Date; end: Date }) {
  const events: Array<LogEvent & { level: LogLevelName }> = []
  const from = range.start.getTime()
  const to = range.end.getTime()
  for (const file of await filesFor(dir, range)) {
    let content: string
    try {
      content = await Bun.file(file).text()
    } catch {
      continue
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      const event = readClefLine(line)
      if (!event) continue
      const time = new Date(event.timestamp).getTime()
      if (time >= from && time <= to) events.push(event)
    }
  }
  return events
}

const propertyValue = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)

export function createLogViewerPort(
  db: Db,
  config: Pick<BunbracoConfig, 'logsDir' | 'logLevel'>,
): LogViewerPort {
  const searches = new LogSearchRepository(db)
  return {
    async canView(range) {
      let bytes = 0
      for (const file of await filesFor(config.logsDir, resolveRange(range)))
        bytes += (await stat(file)).size
      return Math.floor(bytes / 1024 / 1024) <= LOG_SIZE_CAP_MB
    },

    async levelCounts(range) {
      const counts = { information: 0, debug: 0, warning: 0, error: 0, fatal: 0 }
      for (const event of await readEvents(config.logsDir, resolveRange(range))) {
        // Verbose is not counted, as in Umbraco
        const key = event.level.toLowerCase() as keyof typeof counts
        if (key in counts) counts[key] += 1
      }
      return counts
    },

    async templates(range) {
      const counts = new Map<string, number>()
      for (const event of await readEvents(config.logsDir, resolveRange(range)))
        counts.set(event.messageTemplate, (counts.get(event.messageTemplate) ?? 0) + 1)
      return [...counts]
        .map(([messageTemplate, count]) => ({ messageTemplate, count }))
        .sort((a, b) => b.count - a.count)
    },

    async logs(range, query) {
      const matches = logFilter(query.filter)
      const levels = new Set(query.levels.map((l) => l.toLowerCase()))
      const events = (await readEvents(config.logsDir, resolveRange(range)))
        .filter(matches)
        .filter((event) => levels.size === 0 || levels.has(event.level.toLowerCase()))
      const sign = query.direction === 'Ascending' ? 1 : -1
      events.sort((a, b) => (Date.parse(a.timestamp) - Date.parse(b.timestamp)) * sign)
      return events.map(
        (event): LogEntry => ({
          timestamp: event.timestamp,
          level: event.level,
          messageTemplate: event.messageTemplate,
          renderedMessage: event.message,
          exception: event.exception,
          properties: Object.entries(event.properties).map(([name, value]) => ({
            name,
            value: propertyValue(value),
          })),
        }),
      )
    },

    loggers: () => [
      { name: 'Global', level: SERILOG_LEVELS[config.logLevel] as LogLevelName },
      // Everything the loggers pass reaches the file
      { name: 'BunbracoFile', level: 'Verbose' },
    ],

    savedSearches: () => searches.all(),
    savedSearch: (name) => searches.byName(name),
    saveSearch: (name, query) => searches.create(name, query),
    deleteSearch: (name) => searches.delete(name),
  }
}
