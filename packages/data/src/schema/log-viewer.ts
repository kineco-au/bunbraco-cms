/**
 * Migration 012 — the log viewer's saved searches (Umbraco's
 * `umbracoLogViewerQuery`), seeded with Umbraco's installer searches. Two of
 * those ask about Umbraco's own namespaces and message templates; here they ask
 * the same of bunbraco's. The two about Umbraco's `SortedComponentTypes`
 * property, which nothing here logs, are left out.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_USERS_LOCALISATION } from './users-localisation.ts'

export const STATE_LOG_VIEWER = '{6f1d4a8e-0012-4c21-9d3a-8b1e5c7a2f12}'

export const DEFAULT_LOG_SEARCHES: ReadonlyArray<{ name: string; query: string }> = [
  {
    name: 'Find all logs where the Level is NOT Verbose and NOT Debug',
    query: "Not(@Level='Verbose') and Not(@Level='Debug')",
  },
  {
    name: 'Find all logs that has an exception property (Warning, Error & Fatal with Exceptions)',
    query: 'Has(@Exception)',
  },
  { name: "Find all logs that have the property 'Duration'", query: 'Has(Duration)' },
  {
    name: "Find all logs that have the property 'Duration' and the duration is greater than 1000ms",
    query: 'Has(Duration) and Duration > 1000',
  },
  {
    name: "Find all logs that are within the namespace 'bunbraco.schema'",
    query: "StartsWith(SourceContext, 'bunbraco.schema')",
  },
  {
    name: 'Find all logs that use a specific log message template',
    query: "@MessageTemplate = 'Operation {operationId} ({method} {path}) is not implemented'",
  },
  {
    name: 'Find all logs that the message has localhost in it with SQL like',
    query: "@Message like '%localhost%'",
  },
  {
    name: "Find all logs that the message that starts with 'end' in it with SQL like",
    query: "@Message like 'end%'",
  },
]

export const logViewerMigration: Migration = {
  from: STATE_USERS_LOCALISATION,
  to: STATE_LOG_VIEWER,
  name: 'AddLogViewerSavedSearches',
  kind: 'expand',
  release: '0.4.0',
  async up(db: Db) {
    const t = db.dialect.types
    // The name is matched exactly, case and all, as Umbraco matches it
    await db.exec(
      `CREATE TABLE log_viewer_query (
         id ${t.identity},
         name ${t.text} NOT NULL UNIQUE,
         query ${t.text} NOT NULL
       )`,
    )
    for (const search of DEFAULT_LOG_SEARCHES)
      await db.exec('INSERT INTO log_viewer_query (name, query) VALUES (?, ?)', [
        search.name,
        search.query,
      ])
  },
}
