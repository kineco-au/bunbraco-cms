/**
 * Which hostnames reach which page. `domains.toml` is the truth and the
 * database follows it, so `set` and `clear` write the file and then apply it —
 * one command, rather than an edit here and a deploy to make it real.
 */
import {
  bootstrapDatabase,
  type CromboloConfig,
  type DomainDeclaration,
  domainsFilePath,
  readDomainsFile,
  resolveDomainNode,
  syncDomainsFile,
  withoutNode,
  writeDomains,
} from '@crombolo/server'
import { CliError } from '../errors.ts'
import { here } from './describe.ts'
import type { Io } from './site.ts'

/** The file's declarations, saying what is wrong with it as it goes. */
export function readDeclarations(io: Io, config: CromboloConfig) {
  const read = readDomainsFile(config.siteDir)
  for (const problem of read?.problems ?? [])
    io.warning(`  ${domainsFilePath(config.siteDir)}: ${problem}`)
  return { read, declarations: read?.declarations ?? [] }
}

/** Applies the file as a boot would, and reports what it did. */
export async function applyDomains(io: Io, config: CromboloConfig) {
  const { db } = await bootstrapDatabase(config)
  try {
    const report = await syncDomainsFile(db, config.siteDir)
    for (const applied of report.applied)
      io.say(
        `  applied  ${applied.node.padEnd(24)} ${applied.host}${applied.culture ? `  ${applied.culture}` : ''}`,
      )
    if (report.removed > 0) io.say(`  removed  ${report.removed} binding(s)`)
    if (report.problems.length > 0)
      throw new CliError('refused', `${report.problems.length} domain(s) could not be applied.`, {
        details: report.problems,
      })
    return {
      applied: report.applied.map((a) => ({
        node: a.node,
        host: a.host,
        culture: a.culture ?? null,
      })),
      removed: report.removed,
    }
  } finally {
    await db.close()
  }
}

/**
 * Stating a node's hostnames says what they are, as the backoffice's dialog
 * does: whatever that page had is replaced, so running this twice is the same
 * as running it once. Which entries belong to that page is decided by
 * resolving them, not by matching the text — `/` and `/Home` can be the same
 * page, and clearing one while the other stayed would do nothing at all.
 */
export async function rewriteDomains(
  io: Io,
  config: CromboloConfig,
  ref: string,
  add: DomainDeclaration[],
) {
  const { declarations } = readDeclarations(io, config)
  const { db } = await bootstrapDatabase(config)
  let kept: DomainDeclaration[] = []
  try {
    const target = await resolveDomainNode(db, ref)
    if (!target.ok) throw new CliError('not_found', target.message)
    kept = await withoutNode(db, declarations, target.node)
  } finally {
    await db.close()
  }
  const written = await writeDomains(config.siteDir, [...kept, ...add])
  io.say(
    `  wrote    ${here(written.file)}${written.backup ? '  (previous kept; `crombolo domains undo` puts it back)' : ''}`,
  )
  return { wrote: here(written.file), ...(await applyDomains(io, config)) }
}

export const appliedFields = [
  { name: 'applied', type: 'array', items: { type: 'object' } },
  { name: 'removed', type: 'integer' },
] as const
