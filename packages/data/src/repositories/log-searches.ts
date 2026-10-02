/** The log viewer's saved searches, in the order they were saved. */
import type { Db } from '../database.ts'

export class LogSearchRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async all(): Promise<Array<{ name: string; query: string }>> {
    const rows = await this.#db.query<{ name: string; query: string }>(
      'SELECT name, query FROM log_viewer_query ORDER BY id',
    )
    return rows.map((r) => ({ name: String(r.name), query: String(r.query) }))
  }

  async byName(name: string): Promise<{ name: string; query: string } | undefined> {
    return (await this.all()).find((s) => s.name === name)
  }

  async create(name: string, query: string): Promise<'created' | 'duplicate'> {
    if (await this.byName(name)) return 'duplicate'
    await this.#db.exec('INSERT INTO log_viewer_query (name, query) VALUES (?, ?)', [name, query])
    return 'created'
  }

  async delete(name: string): Promise<boolean> {
    if (!(await this.byName(name))) return false
    await this.#db.exec('DELETE FROM log_viewer_query WHERE name = ?', [name])
    return true
  }
}
