/** The Settings section's log viewer: the site's log files, and the searches saved against them. */

export type LogLevelName = 'Verbose' | 'Debug' | 'Information' | 'Warning' | 'Error' | 'Fatal'

export interface LogRange {
  start: Date | null
  end: Date | null
}

export interface LogEntry {
  timestamp: string
  level: LogLevelName
  messageTemplate: string
  renderedMessage: string
  exception: string | null
  properties: Array<{ name: string; value: string | null }>
}

export interface LogViewerPort {
  /** Whether the files for the range are small enough to read (Umbraco's 100 MB cap). */
  canView(range: LogRange): Promise<boolean>
  levelCounts(
    range: LogRange,
  ): Promise<{ information: number; debug: number; warning: number; error: number; fatal: number }>
  /** Each message template with how often it was logged, most frequent first. */
  templates(range: LogRange): Promise<Array<{ messageTemplate: string; count: number }>>
  /** Entries matching the filter expression and levels, ordered by time. */
  logs(
    range: LogRange,
    query: { filter: string | null; levels: LogLevelName[]; direction: 'Ascending' | 'Descending' },
  ): Promise<LogEntry[]>
  /** The loggers and the least severe level each writes; `Global` is the one the viewer shows. */
  loggers(): Array<{ name: string; level: LogLevelName }>
  savedSearches(): Promise<Array<{ name: string; query: string }>>
  savedSearch(name: string): Promise<{ name: string; query: string } | undefined>
  saveSearch(name: string, query: string): Promise<'created' | 'duplicate'>
  deleteSearch(name: string): Promise<boolean>
}
