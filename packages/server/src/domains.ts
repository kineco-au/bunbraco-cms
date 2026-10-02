/**
 * `domains.toml`: which hostnames reach which page, and in which culture.
 *
 * Hostnames are the one piece of site metadata that differs in every
 * environment, so they are neither content nor schema. They are a file of their
 * own at the site root — data, not code, so `bunbraco domains set` can write it
 * — with `${VAR}` read from the environment at sync time, which is how one
 * committed file serves development, staging and production.
 *
 * The file is the truth. Boot converges the `domain` table onto it, so deleting
 * an entry takes effect, exactly as `syncConfiguredRedirects` does for rules in
 * the config. A site with no `domains.toml` is left alone entirely: nothing to
 * converge onto means the backoffice stays the only way, as it was before.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ObjectTypes } from '@bunbraco/core'
import {
  type Db,
  DocumentRepository,
  DomainRepository,
  describeRefFailure,
  LanguageRepository,
  NodeRepository,
  type NodeRow,
  resolveNodeRef,
} from '@bunbraco/data'

export const DOMAINS_FILE = 'domains.toml'

/** One hostname bound to one node, as the file declares it. */
export interface DomainDeclaration {
  /** A content path (`/`, `/fr`) or a node uuid; resolved when the file is applied. */
  node: string
  /** A hostname, optionally with a port and a path, and optionally `${VAR}`. */
  host: string
  /** The culture this hostname serves; absent means the site's default. */
  culture?: string
  /** The culture the node itself falls back to, with or without a hostname. */
  defaultCulture?: string
}

export interface DomainsFileResult {
  declarations: DomainDeclaration[]
  problems: string[]
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

export function parseDomainsFile(source: string): DomainsFileResult {
  const problems: string[] = []
  let raw: Record<string, unknown>
  try {
    raw = Bun.TOML.parse(source) as Record<string, unknown>
  } catch (error) {
    return { declarations: [], problems: [`invalid TOML: ${(error as Error).message}`] }
  }
  const entries = Array.isArray(raw.domain) ? (raw.domain as Record<string, unknown>[]) : []
  if (raw.domain !== undefined && entries.length === 0)
    problems.push('`domain` must be a list of `[[domain]]` entries')

  const declarations: DomainDeclaration[] = []
  for (const [index, entry] of entries.entries()) {
    const where = `domain[${index}]`
    const node = str(entry.node)
    const host = str(entry.host)
    const culture = str(entry.culture)
    const defaultCulture = str(entry['default-culture'])
    if (!node) {
      problems.push(`${where}: no \`node\``)
      continue
    }
    // An entry may carry only a default culture: a node can vary by culture
    // without a hostname of its own, which is what Umbraco's `*<id>` row means.
    if (!host && !defaultCulture) {
      problems.push(`${where}: needs a \`host\`, a \`default-culture\`, or both`)
      continue
    }
    declarations.push({ node, host: host ?? '', culture, defaultCulture })
  }
  return { declarations, problems }
}

/** Model → canonical TOML, so a rewrite by the CLI reads as a hand-written file. */
export function writeDomainsFile(declarations: readonly DomainDeclaration[]): string {
  const quote = (value: string) => JSON.stringify(value)
  const lines: string[] = [
    '# Which hostnames reach which page, and in which culture.',
    `# \`\${VAR}\` is read from the environment when this is applied, so one file`,
    '# serves every environment. `bunbraco domains` prints what is in force.',
  ]
  for (const declaration of declarations) {
    lines.push('', '[[domain]]', `node = ${quote(declaration.node)}`)
    if (declaration.host) lines.push(`host = ${quote(declaration.host)}`)
    if (declaration.culture) lines.push(`culture = ${quote(declaration.culture)}`)
    if (declaration.defaultCulture)
      lines.push(`default-culture = ${quote(declaration.defaultCulture)}`)
  }
  return `${lines.join('\n')}\n`
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** `${VAR}` from the environment; an unset one is reported rather than guessed. */
export function resolvePlaceholders(
  value: string,
  env: Record<string, string | undefined> = Bun.env,
): { value: string; missing: string[] } {
  const missing: string[] = []
  const resolved = value.replace(PLACEHOLDER, (_, name: string) => {
    const found = env[name]
    if (found === undefined || found === '') {
      missing.push(name)
      return ''
    }
    return found
  })
  return { value: resolved, missing }
}

export interface DomainsSyncReport {
  /** No `domains.toml`: nothing was read and nothing was changed. */
  action: 'absent' | 'applied'
  /** Hostnames now bound, after interpolation. */
  applied: Array<{ node: string; host: string; culture?: string }>
  /** Bindings removed because the file no longer declares them. */
  removed: number
  /** Anything that stopped one entry being applied; the rest still are. */
  problems: string[]
}

export function domainsFilePath(siteDir: string): string {
  return join(siteDir, DOMAINS_FILE)
}

/** What `domains undo` restores: the file as it was before the last write. */
export const DOMAINS_BACKUP_FILE = `${DOMAINS_FILE}.bak`

/**
 * Writes the file, keeping the one it replaces.
 *
 * A wrong hostname takes a site off the air — once a root page has one, that is
 * the only name it answers on — so every write leaves the previous text beside
 * it and `undoDomainsFile` puts it back. On a production node the backup is as
 * ephemeral as the file itself, which is why the change is worth committing.
 */
export async function writeDomains(
  siteDir: string,
  declarations: readonly DomainDeclaration[],
): Promise<{ file: string; backup: string | undefined }> {
  const file = domainsFilePath(siteDir)
  const backup = join(siteDir, DOMAINS_BACKUP_FILE)
  const kept = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  if (kept !== undefined) await Bun.write(backup, kept)
  await Bun.write(file, writeDomainsFile(declarations))
  return { file, backup: kept === undefined ? undefined : backup }
}

/** Puts back what the last write replaced; the current file becomes the backup. */
export async function undoDomainsFile(
  siteDir: string,
): Promise<{ ok: boolean; file: string; message?: string }> {
  const file = domainsFilePath(siteDir)
  const backup = join(siteDir, DOMAINS_BACKUP_FILE)
  if (!existsSync(backup))
    return { ok: false, file, message: `there is no ${DOMAINS_BACKUP_FILE} to go back to` }
  const previous = readFileSync(backup, 'utf8')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  await Bun.write(file, previous)
  // So that undo is itself undoable, which is what somebody who has just undone
  // the wrong thing needs.
  await Bun.write(backup, current ?? '')
  return { ok: true, file }
}

/**
 * What to call a page in the file: whatever it is already called there, so a
 * readable path written by a person stays a path, and its uuid when the file
 * has not mentioned it before.
 */
export async function nodeReferenceFor(
  db: Db,
  declarations: readonly DomainDeclaration[],
  node: NodeRow,
): Promise<string> {
  for (const name of new Set(declarations.map((declaration) => declaration.node))) {
    const resolved = await resolveDomainNode(db, name)
    if (resolved.ok && resolved.node.id === node.id) return name
  }
  return node.key
}

/**
 * Every entry except the ones that belong to this page.
 *
 * Which they are is decided by resolving each entry, not by matching the text:
 * `/` and `/Home` can be the same page, so clearing one by the name the file
 * did not use would otherwise leave it bound.
 */
export async function withoutNode(
  db: Db,
  declarations: readonly DomainDeclaration[],
  node: NodeRow,
): Promise<DomainDeclaration[]> {
  const kept: DomainDeclaration[] = []
  for (const declaration of declarations) {
    const owner = await resolveDomainNode(db, declaration.node)
    if (owner.ok && owner.node.id === node.id) continue
    kept.push(declaration)
  }
  return kept
}

/**
 * Replaces one page's entries, leaving every other entry exactly as written.
 *
 * The file is rewritten from the model, not from the database: regenerating it
 * wholesale would resolve `${VAR}` in other entries into whatever this machine
 * happens to have, baking one environment's hostnames into a file that serves
 * all of them.
 */
export function replaceNodeDeclarations(
  existing: readonly DomainDeclaration[],
  node: string,
  hosts: ReadonlyArray<{ host: string; culture?: string }>,
  defaultCulture?: string,
): DomainDeclaration[] {
  const others = existing.filter((declaration) => declaration.node !== node)
  if (hosts.length === 0 && !defaultCulture) return others
  if (hosts.length === 0) return [...others, { node, host: '', defaultCulture }]
  return [
    ...others,
    ...hosts.map((entry, index) => ({
      node,
      host: entry.host,
      culture: entry.culture,
      defaultCulture: index === 0 ? defaultCulture : undefined,
    })),
  ]
}

/**
 * The page a declaration names: a path, a uuid, or `/` for the root page.
 *
 * `/` is what a visitor types, and on a site with one root it is unambiguous —
 * but a hostname binds to a *node*, so with several roots it is refused with
 * their names rather than guessed at.
 */
export async function resolveDomainNode(
  db: Db,
  ref: string,
): Promise<{ ok: true; node: NodeRow } | { ok: false; message: string }> {
  if (ref.trim() === '/') {
    const roots = (await new DocumentRepository(db).children(null, 0, 50)).items
    const first = roots[0]
    if (!first) return { ok: false, message: 'this site has no pages at the root' }
    if (roots.length > 1)
      return {
        ok: false,
        message: `"/" matches ${roots.length} root pages (${roots.map((r) => r.text).join(', ')}) — name one`,
      }
    return { ok: true, node: first }
  }
  const resolved = await resolveNodeRef(db, [ObjectTypes.Document], ref)
  return resolved.ok
    ? { ok: true, node: resolved.node }
    : { ok: false, message: describeRefFailure(ref, resolved) }
}

export function readDomainsFile(siteDir: string): DomainsFileResult | undefined {
  const file = domainsFilePath(siteDir)
  return existsSync(file) ? parseDomainsFile(readFileSync(file, 'utf8')) : undefined
}

/**
 * Converges the `domain` table onto the file.
 *
 * Entries are grouped by node because an assignment is replaced per node, as
 * the backoffice's dialog replaces it: stating a node's hostnames says what
 * they are. Nodes the file does not name keep nothing — the file is the truth,
 * so a binding it dropped goes — but a site with no file at all is untouched.
 */
export async function syncDomainsFile(
  db: Db,
  siteDir: string,
  env: Record<string, string | undefined> = Bun.env,
): Promise<DomainsSyncReport> {
  const read = readDomainsFile(siteDir)
  if (!read) return { action: 'absent', applied: [], removed: 0, problems: [] }

  const problems = [...read.problems]
  const applied: DomainsSyncReport['applied'] = []
  const domains = new DomainRepository(db)
  const nodes = new NodeRepository(db)
  // A hostname with no culture of its own serves the site's default one, which
  // is what the dialog means by leaving the language unset — the repository
  // wants an actual language, so it is resolved here rather than sent empty.
  const languages = await new LanguageRepository(db).all()
  const defaultCulture = languages.find((language) => language.isDefault)?.isoCode ?? ''

  const byNode = new Map<string, DomainDeclaration[]>()
  for (const declaration of read.declarations) {
    const group = byNode.get(declaration.node)
    if (group) group.push(declaration)
    else byNode.set(declaration.node, [declaration])
  }

  const kept = new Set<number>()
  const namedBy = new Map<number, string>()
  for (const [node, declarations] of byNode) {
    const resolved = await resolveDomainNode(db, node)
    if (!resolved.ok) {
      problems.push(resolved.message)
      continue
    }
    // `/` and `/Home` can be the same page. Each group replaces that page's
    // whole assignment, so without this the later one silently wins and the
    // earlier one's hostnames are gone with nothing having said so.
    const already = namedBy.get(resolved.node.id)
    if (already !== undefined) {
      problems.push(`${node}: the same page as "${already}" — name it once`)
      continue
    }
    namedBy.set(resolved.node.id, node)
    const hosts: Array<{ domainName: string; isoCode: string }> = []
    const wanted: DomainsSyncReport['applied'] = []
    let defaultIsoCode: string | null = null
    for (const declaration of declarations) {
      if (declaration.defaultCulture) defaultIsoCode = declaration.defaultCulture
      if (!declaration.host) continue
      const host = resolvePlaceholders(declaration.host, env)
      if (host.missing.length > 0) {
        // Skipped rather than bound to a half-interpolated name: a hostname
        // built from an unset variable would answer for nobody and hide the
        // mistake. The site still starts; the problem is reported.
        problems.push(
          `${node}: ${declaration.host} is not applied — ${host.missing.join(', ')} ${host.missing.length === 1 ? 'is' : 'are'} not set in this environment`,
        )
        continue
      }
      hosts.push({ domainName: host.value, isoCode: declaration.culture ?? defaultCulture })
      wanted.push({ node, host: host.value, culture: declaration.culture })
    }

    const result = await domains.setForNode(resolved.node.id, { defaultIsoCode, domains: hosts })
    if (result.status !== 'ok') {
      problems.push(`${node}: ${describeSetFailure(result)}`)
      continue
    }
    // Only once it is in the database: reporting a binding that was refused is
    // how a hostname that is not serving anything looks like one that is.
    applied.push(...wanted)
    kept.add(resolved.node.id)
  }

  // Anything bound to a node the file no longer names. `setForNode` already
  // replaced the assignments of the nodes it does name.
  let removed = 0
  const nodeIds = new Set((await domains.all()).map((row) => row.nodeId))
  for (const nodeId of nodeIds) {
    if (kept.has(nodeId)) continue
    const node = await nodes.byId(nodeId)
    if (!node) continue
    const before = await domains.forNode(nodeId)
    await domains.setForNode(nodeId, { defaultIsoCode: null, domains: [] })
    removed += before.domains.length + (before.defaultIsoCode ? 1 : 0)
  }

  return { action: 'applied', applied, removed, problems }
}

function describeSetFailure(result: { status: string; domainName?: string; isoCode?: string }) {
  switch (result.status) {
    case 'invalidLanguage':
      return `no language "${result.isoCode}" is configured here`
    case 'invalidName':
      return `"${result.domainName}" is not a valid hostname`
    case 'conflict':
      return `"${result.domainName}" is already bound to another page`
    default:
      return result.status
  }
}
