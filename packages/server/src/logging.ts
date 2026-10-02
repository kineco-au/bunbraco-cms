/**
 * Logging, through LogTape, into the files Umbraco's log viewer reads: Serilog's
 * compact JSON (CLEF), one event per line, one file per machine per UTC day in
 * the site's `logs/` — `BunbracoTraceLog.<machine>.<yyyyMMdd>.json`, after
 * Umbraco's `UmbracoTraceLog.<machine>.<yyyyMMdd>.json`. A message is a
 * template (`'Published {name}'`) with its properties, as Serilog's are; an
 * `error` property carries the exception.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  configureSync,
  getConsoleSink,
  getLogger,
  type Logger,
  type LogLevel,
  type LogRecord,
  type Sink,
} from '@logtape/logtape'

/** Serilog's level names, which the log viewer filters and counts by. */
export const SERILOG_LEVELS: Record<LogLevel, string> = {
  trace: 'Verbose',
  debug: 'Debug',
  info: 'Information',
  warning: 'Warning',
  error: 'Error',
  fatal: 'Fatal',
}

export const LOG_FILE_PREFIX = 'BunbracoTraceLog'

/** Today's file for this machine: the day is UTC, as the timestamps are. */
export function logFileName(date: Date, machine = hostname()): string {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '')
  return `${LOG_FILE_PREFIX}.${machine.replace(/[^A-Za-z0-9_-]/g, '_')}.${day}.json`
}

const renderValue = (value: unknown): unknown => {
  if (value instanceof Error) return value.message
  if (value instanceof Date) return value.toISOString()
  return value
}

/** One CLEF event: `@t`, `@mt`, `@l` (left out for Information, as Serilog does), `@x`, then properties. */
export function toClef(record: LogRecord): Record<string, unknown> {
  const { error, ...properties } = record.properties
  const event: Record<string, unknown> = {
    '@t': new Date(record.timestamp).toISOString(),
    '@mt': typeof record.rawMessage === 'string' ? record.rawMessage : record.rawMessage.join('{}'),
  }
  if (record.level !== 'info') event['@l'] = SERILOG_LEVELS[record.level]
  if (error !== undefined)
    event['@x'] =
      error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
  for (const [name, value] of Object.entries(properties)) event[name] = renderValue(value)
  event.SourceContext = record.category.join('.')
  event.MachineName = hostname()
  event.ProcessId = process.pid
  return event
}

/** Appends each event to the day's file; written synchronously, so nothing is lost on a crash. */
export function getClefFileSink(dir: string): Sink {
  let made = false
  return (record) => {
    if (!made) {
      mkdirSync(dir, { recursive: true })
      made = true
    }
    appendFileSync(
      join(dir, logFileName(new Date(record.timestamp))),
      `${JSON.stringify(toClef(record))}\n`,
    )
  }
}

export interface LoggingOptions {
  logsDir: string
  /** The least severe level written, for the files and the console alike. */
  level: LogLevel
  /** Whether events are also printed; tests turn it off. */
  console: boolean
}

/**
 * Points every `bunbraco` logger at the site's files (and the console). LogTape
 * holds one configuration per process, so the most recently started server's
 * wins.
 */
export function configureLogging(options: LoggingOptions): void {
  configureSync({
    reset: true,
    sinks: {
      file: getClefFileSink(options.logsDir),
      console: getConsoleSink(),
    },
    loggers: [
      {
        category: ['bunbraco'],
        lowestLevel: options.level,
        sinks: options.console ? ['file', 'console'] : ['file'],
      },
      // The development 501 log prints its own line; its events only go to the file
      {
        category: ['bunbraco', 'not-implemented'],
        sinks: ['file'],
        parentSinks: 'override',
      },
      // The request trace is thousands of lines per backoffice boot: the console
      // only, so the log viewer's files stay readable
      {
        category: ['bunbraco', 'http'],
        sinks: options.console ? ['console'] : [],
        parentSinks: 'override',
      },
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
    ],
  })
}

/** A logger for one part of the server; its category becomes the event's `SourceContext`. */
export function logger(...category: string[]): Logger {
  return getLogger(['bunbraco', ...category])
}
