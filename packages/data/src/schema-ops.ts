/**
 * Schema operations on the dialect seam, so a migration is written once.
 * Bun's SQLite is recent enough for `ALTER TABLE … DROP COLUMN` and
 * `RENAME COLUMN`, so nothing here needs the copy-table dance.
 */
import type { Db } from './database.ts'

export interface SchemaOps {
  addColumn(table: string, column: string, definition: string): Promise<void>
  dropColumn(table: string, column: string): Promise<void>
  renameColumn(table: string, from: string, to: string): Promise<void>
  renameTable(from: string, to: string): Promise<void>
  addIndex(name: string, table: string, columns: readonly string[], unique?: boolean): Promise<void>
  dropIndex(name: string, table: string): Promise<void>
  dropTable(table: string): Promise<void>
}

export function schemaOps(db: Db): SchemaOps {
  const q = (identifier: string) => db.dialect.quote(identifier)
  return {
    addColumn: (table, column, definition) =>
      db.exec(`ALTER TABLE ${q(table)} ADD COLUMN ${q(column)} ${definition}`),
    dropColumn: (table, column) => db.exec(`ALTER TABLE ${q(table)} DROP COLUMN ${q(column)}`),
    renameColumn: (table, from, to) =>
      db.exec(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(from)} TO ${q(to)}`),
    renameTable: (from, to) => db.exec(`ALTER TABLE ${q(from)} RENAME TO ${q(to)}`),
    addIndex: (name, table, columns, unique = false) =>
      db.exec(
        `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(table)} (${columns.map(q).join(', ')})`,
      ),
    // Postgres drops an index by name alone; SQLite too. `table` documents intent.
    dropIndex: (name) => db.exec(`DROP INDEX ${q(name)}`),
    dropTable: (table) => db.exec(`DROP TABLE ${q(table)}`),
  }
}
