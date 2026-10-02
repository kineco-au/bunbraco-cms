/**
 * Rollback is a backup (docs/10-packaging-and-upgrades.md): SQLite is copied
 * beside the database; Postgres runs the operator's `BUNBRACO_PG_DUMP` command
 * or refuses unless the caller vouches with `--backup-taken`.
 */
import { copyFileSync, existsSync } from 'node:fs'
import type { BunbracoConfig } from './config.ts'

export interface BackupOptions {
  /** The operator has taken a Postgres backup themselves. */
  backupTaken?: boolean
  /** What the backup is for; goes into the file name. */
  reason: string
}

export interface BackupResult {
  kind: 'sqlite-copy' | 'pg-dump' | 'operator' | 'none'
  path?: string
}

export class BackupRequiredError extends Error {
  constructor() {
    super(
      'Postgres needs a backup before this writes: set BUNBRACO_PG_DUMP to a command that takes one, or pass --backup-taken.',
    )
  }
}

export async function backupBefore(
  config: BunbracoConfig,
  options: BackupOptions,
): Promise<BackupResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (config.dialect === 'sqlite') {
    if (config.sqliteFile === ':memory:' || !existsSync(config.sqliteFile)) return { kind: 'none' }
    const path = `${config.sqliteFile}.${stamp}.${options.reason}.bak`
    copyFileSync(config.sqliteFile, path)
    return { kind: 'sqlite-copy', path }
  }
  if (config.pgDump) {
    const proc = Bun.spawn(['sh', '-c', config.pgDump], {
      env: { ...process.env, BUNBRACO_BACKUP_STAMP: stamp, BUNBRACO_BACKUP_REASON: options.reason },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`BUNBRACO_PG_DUMP exited with ${code}; not continuing.`)
    return { kind: 'pg-dump' }
  }
  if (options.backupTaken) return { kind: 'operator' }
  throw new BackupRequiredError()
}
