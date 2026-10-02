/**
 * What a reviewer sees before approving: the proposal against what is there now.
 *
 * The changeset stores the prepared request, not a snapshot of the old values, so
 * the "before" side is read at review time. That is the right way round — it means
 * the diff shown is against the entity as it stands when someone looks at it, not
 * as it stood when the model was talking, and a proposal whose baseline has moved
 * says so here rather than surprising them after they click Approve.
 */
import type { ProposedChange, SchemaProposalPort } from './changeset.ts'
import { type ChangeKind, SCHEMA_KINDS } from './operations.ts'
import type { ManagementCall } from './tools.ts'

export interface FieldChange {
  /** The property alias, or a field name for a type. */
  name: string
  /** Absent for a culture-invariant value. */
  culture?: string | null
  before: unknown
  after: unknown
}

export interface ChangeReview {
  kind: ChangeKind
  /** True when nothing exists yet, so every field is new. */
  creating: boolean
  fields: FieldChange[]
  /** Whole-text diff sides, for a template. */
  source?: { before: string; after: string }
  /** Set when the entity moved after the proposal was made. */
  stale: boolean
}

/** Which read gives the current state, and the part of it that matters. */
const CURRENT: Partial<Record<ChangeKind, string>> = {
  document: 'GetDocumentById',
  'document-type': 'GetDocumentTypeById',
  'data-type': 'GetDataTypeById',
  template: 'GetTemplateById',
}

const digest = (value: unknown): string =>
  new Bun.CryptoHasher('sha256').update(JSON.stringify(value ?? null)).digest('hex')

interface ValueEntry {
  alias: string
  value?: unknown
  culture?: string | null
  segment?: string | null
}

interface VariantEntry {
  culture?: string | null
  segment?: string | null
  name?: string
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const variantKey = (variant: VariantEntry) => `${variant.culture ?? ''}|${variant.segment ?? ''}`

/**
 * Renames, as fields, so they appear in the list a reviewer reads.
 *
 * A document proposal carries the whole `variants` array because the update
 * handler needs it, which means a rename can ride along inside what looks like a
 * value edit. Compared per culture and segment, so a page that simply has
 * different names in different languages is not reported as renamed.
 */
export function variantChanges(
  before: readonly VariantEntry[],
  after: readonly VariantEntry[],
): FieldChange[] {
  const was = new Map(before.map((variant) => [variantKey(variant), variant.name ?? '']))
  const changes: FieldChange[] = []
  for (const variant of after) {
    const previous = was.get(variantKey(variant))
    const name = variant.name ?? ''
    if (previous === undefined || previous === name) continue
    changes.push({ name: 'Name', culture: variant.culture ?? null, before: previous, after: name })
  }
  return changes
}

/** Values that differ, in the proposal's order, with anything untouched left out. */
function valueChanges(before: readonly ValueEntry[], after: readonly ValueEntry[]): FieldChange[] {
  const changes: FieldChange[] = []
  for (const entry of after) {
    const previous = before.find(
      (candidate) =>
        candidate.alias === entry.alias &&
        (candidate.culture ?? null) === (entry.culture ?? null) &&
        (candidate.segment ?? null) === (entry.segment ?? null),
    )
    if (same(previous?.value, entry.value)) continue
    changes.push({
      name: entry.alias,
      culture: entry.culture ?? null,
      before: previous?.value,
      after: entry.value,
    })
  }
  return changes
}

/**
 * Fields of a type that differ. Compared as JSON at one level, which reads well
 * for the scalars that matter (name, alias, icon) and honestly for the lists
 * (properties, compositions) without pretending to a structural diff.
 */
function bodyChanges(before: unknown, after: unknown): FieldChange[] {
  const previous = (before ?? {}) as Record<string, unknown>
  const proposed = (after ?? {}) as Record<string, unknown>
  const changes: FieldChange[] = []
  for (const [name, value] of Object.entries(proposed)) {
    if (same(previous[name], value)) continue
    changes.push({ name, before: previous[name], after: value })
  }
  return changes
}

export async function reviewChange(
  change: ProposedChange,
  options: {
    call: ManagementCall
    operationPath: (operationId: string) => string | undefined
    /** Reads the schema file a TOML proposal would replace. */
    schema?: SchemaProposalPort
  },
): Promise<ChangeReview> {
  const creating = change.kind.endsWith('-create')
  const body = (change.body ?? {}) as Record<string, unknown>

  // A schema proposal is a file, so it reads as one: the TOML on disk beside the
  // TOML that would replace it.
  if (SCHEMA_KINDS.has(change.kind)) {
    const alias = typeof body.alias === 'string' ? body.alias : ''
    const before = (await options.schema?.read(change.kind, alias)) ?? ''
    const after = typeof body.toml === 'string' ? body.toml : ''
    return {
      kind: change.kind,
      creating,
      fields: [],
      source: { before, after },
      stale: change.baseline !== undefined && digest(before) !== change.baseline,
    }
  }

  if (creating) {
    const fields =
      change.kind === 'document-create'
        ? valueChanges([], (body.values as ValueEntry[]) ?? [])
        : bodyChanges(
            {},
            change.kind === 'template-create' ? { ...body, content: undefined } : body,
          )
    const review: ChangeReview = { kind: change.kind, creating: true, fields, stale: false }
    if (change.kind === 'template-create') {
      review.source = { before: '', after: String(body.content ?? '') }
    }
    return review
  }

  const operationId = CURRENT[change.kind]
  const template = operationId ? options.operationPath(operationId) : undefined
  if (!operationId || !template) {
    return { kind: change.kind, creating: false, fields: [], stale: false }
  }

  const path = template.replace('{id}', encodeURIComponent(change.params.id ?? ''))
  const current = await options.call({ method: 'get', path })
  if (current.status !== 200) {
    return { kind: change.kind, creating: false, fields: [], stale: true }
  }

  if (change.kind === 'template') {
    const before = String((current.body as { content?: string | null }).content ?? '')
    return {
      kind: change.kind,
      creating: false,
      fields: [],
      source: { before, after: String(body.content ?? '') },
      stale: change.baseline !== undefined && digest(before) !== change.baseline,
    }
  }

  const stale = change.baseline !== undefined && digest(current.body) !== change.baseline

  if (change.kind === 'document') {
    const now = current.body as { values?: ValueEntry[]; variants?: VariantEntry[] }
    return {
      kind: change.kind,
      creating: false,
      fields: [
        // Renames first: a page's name is not a property value, so without this
        // the diff a reviewer approves would not show one at all.
        ...variantChanges(now.variants ?? [], (body.variants as VariantEntry[]) ?? []),
        ...valueChanges(now.values ?? [], (body.values as ValueEntry[]) ?? []),
      ],
      stale,
    }
  }

  return { kind: change.kind, creating: false, fields: bodyChanges(current.body, body), stale }
}
