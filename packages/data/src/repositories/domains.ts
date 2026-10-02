/**
 * Culture and hostnames (Umbraco's `umbracoDomain`): hostnames that make a
 * document a site root, each with a culture, plus an optional wildcard that only
 * sets the culture of a branch. The wildcard is stored as Umbraco stores it, a
 * row named `*<node id>`.
 */
import type { Db } from '../database.ts'

export interface DomainAssignment {
  defaultIsoCode: string | null
  domains: Array<{ domainName: string; isoCode: string }>
}

export interface DomainRow {
  nodeId: number
  domainName: string
  isoCode: string | null
  isWildcard: boolean
  sortOrder: number
}

export type SetDomainsResult =
  | { status: 'ok' }
  | { status: 'invalidLanguage'; isoCode: string }
  | { status: 'invalidName'; domainName: string }
  | { status: 'conflict'; domainName: string }

/** `https://Example.com/en/` → `example.com/en`; what matching and uniqueness compare. */
export function normaliseDomainName(name: string): string {
  return name
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

const VALID_DOMAIN = /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._~%-]+)*$/i

export class DomainRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async all(): Promise<DomainRow[]> {
    const rows = await this.#db.query(
      `SELECT d.node_id, d.domain_name, d.sort_order, l.iso_code FROM domain d
       LEFT JOIN language l ON l.id = d.language_id ORDER BY d.node_id, d.sort_order, d.id`,
    )
    return rows.map((row) => ({
      nodeId: Number(row.node_id),
      domainName: String(row.domain_name),
      isoCode: (row.iso_code as string | null) ?? null,
      isWildcard: String(row.domain_name).startsWith('*'),
      sortOrder: Number(row.sort_order),
    }))
  }

  async forNode(nodeId: number): Promise<DomainAssignment> {
    const rows = (await this.all()).filter((row) => row.nodeId === nodeId)
    return {
      defaultIsoCode: rows.find((row) => row.isWildcard)?.isoCode ?? null,
      domains: rows
        .filter((row) => !row.isWildcard)
        .map((row) => ({ domainName: row.domainName, isoCode: row.isoCode ?? '' })),
    }
  }

  /** Replaces a node's domains. Names are unique across the site, and each culture must exist. */
  async setForNode(nodeId: number, assignment: DomainAssignment): Promise<SetDomainsResult> {
    const languages = await this.#db.query<{ id: number; iso_code: string }>(
      'SELECT id, iso_code FROM language',
    )
    const languageId = (iso: string) =>
      languages.find((l) => String(l.iso_code).toLowerCase() === iso.toLowerCase())?.id
    if (assignment.defaultIsoCode && languageId(assignment.defaultIsoCode) === undefined)
      return { status: 'invalidLanguage', isoCode: assignment.defaultIsoCode }
    const names: string[] = []
    for (const domain of assignment.domains) {
      if (languageId(domain.isoCode) === undefined)
        return { status: 'invalidLanguage', isoCode: domain.isoCode }
      const name = normaliseDomainName(domain.domainName)
      if (!VALID_DOMAIN.test(name)) return { status: 'invalidName', domainName: domain.domainName }
      if (names.includes(name)) return { status: 'conflict', domainName: domain.domainName }
      names.push(name)
    }
    const taken = (await this.all()).filter(
      (row) => !row.isWildcard && row.nodeId !== nodeId && names.includes(row.domainName),
    )
    if (taken[0]) return { status: 'conflict', domainName: taken[0].domainName }

    await this.#db.transaction(async (tx) => {
      await tx.exec('DELETE FROM domain WHERE node_id = ?', [nodeId])
      if (assignment.defaultIsoCode)
        await tx.exec(
          'INSERT INTO domain (node_id, language_id, domain_name, sort_order) VALUES (?, ?, ?, ?)',
          [nodeId, languageId(assignment.defaultIsoCode), `*${nodeId}`, 0],
        )
      for (const [index, domain] of assignment.domains.entries())
        await tx.exec(
          'INSERT INTO domain (node_id, language_id, domain_name, sort_order) VALUES (?, ?, ?, ?)',
          [nodeId, languageId(domain.isoCode), names[index], index],
        )
    })
    return { status: 'ok' }
  }
}
