/**
 * The dry run: what importing this bundle would do here, and what it needs
 * from someone first.
 *
 * Read-only, and it runs before every import rather than only when asked
 * (`13-content-transfer.md`). The point is that nothing is written until the
 * conflicts are named and answered, so a transfer is never a surprise.
 *
 * Findings share the shape, table, endpoint and dashboard of the pre-upgrade
 * check, in the same three kinds:
 *
 * - **blocking** — the destination cannot honour the bundle. Deploy something,
 *   or re-root it. No resolution makes it importable as it stands.
 * - **person** — importable, but somebody has to choose. A resolution answers it.
 * - **auto** — what the import will do, reported so it is not a surprise.
 */
import { ObjectTypes } from '@bunbraco/core'
import {
  ContentTypeRepository,
  currentSchemaState,
  DataTypeRepository,
  type Db,
  DocumentRepository,
  type Finding,
  LanguageRepository,
  type NodeRow,
} from '@bunbraco/data'
import type { BundleNode, ContentSet } from './model.ts'
import { referenceCandidates } from './references.ts'

/** What a person can decide about a node the destination already has. */
export type Resolution = 'take-bundle' | 'keep-local' | 'skip'

export const RESOLUTIONS: readonly Resolution[] = ['take-bundle', 'keep-local', 'skip']

export const isResolution = (value: string): value is Resolution =>
  (RESOLUTIONS as readonly string[]).includes(value)

/**
 * What to suggest for a finding, as a function of its code — so the table keeps
 * its stable shape and both the CLI and the dashboard render the same advice.
 */
export function resolutionsFor(code: string): readonly string[] {
  switch (code) {
    case 'local-edit':
      return [
        '--resolve <key>=take-bundle to let the bundle win',
        '--resolve <key>=keep-local to keep what is here',
        '--resolve <key>=skip to leave the node alone entirely',
        '--resolve-all=<choice> to answer every one the same way',
      ]
    case 'missing-parent':
      return [
        'deploy or transfer the parent first',
        '--under <path|uuid> to place it somewhere else',
      ]
    case 'missing-dependency':
      return ['transfer the missing node first', 'or remove the value that refers to it']
    case 'missing-content-type':
      return ['deploy schema/ to this environment first']
    case 'language-missing':
      return ['add the language in Settings, or deploy schema/languages.toml']
    case 'editor-mismatch':
      return ['deploy the schema change that altered the property editor']
    case 'local-trashed':
      return ['restore the node from the recycle bin, or --resolve <key>=skip']
    case 'missing-blob':
      return [
        'bunbraco media sync, once it lands',
        '--allow-missing-blobs to import the metadata anyway',
      ]
    case 'unresolved-reference':
      return ['transfer the node it refers to', 'or accept a value that points at nothing']
    case 'name-collision':
      return ['rename one of them, or --resolve <key>=skip']
    case 'missing-template':
      return ['deploy the view, and the template attaches on the next save']
    default:
      return []
  }
}

export interface CheckOptions {
  /** Re-root the bundle here instead of at the parents it names. */
  under?: NodeRow | undefined
  /** Per-node decisions, by node key. */
  resolutions?: Readonly<Record<string, Resolution>>
  /** One decision for every node that needs one. */
  resolveAll?: Resolution | undefined
  /** Template aliases with a view on disk; absent means templates are not checked. */
  templateAliases?: ReadonlySet<string> | undefined
  /** Whether a media blob is present in this environment's store. */
  hasBlob?: ((key: string) => Promise<boolean>) | undefined
  allowMissingBlobs?: boolean
  /** For linking a finding to the document it is about. */
  backOfficePath?: string
}

/** What the import would do to one node. */
export interface NodePlan {
  key: string
  name: string
  kind: BundleNode['kind']
  action: 'create' | 'update' | 'unchanged' | 'skip'
  /** Property aliases whose value would change. */
  changing: string[]
  resolution: Resolution | undefined
}

export interface TransferCheck {
  bundleId: string
  findings: Finding[]
  /** What stops an import: every blocking finding, plus the unanswered ones. */
  outstanding: Finding[]
  plan: NodePlan[]
  counts: { create: number; update: number; unchanged: number; skip: number }
}

const documentLink = (backOfficePath: string | undefined, key: string): string | null =>
  backOfficePath ? `${backOfficePath}/section/content/workspace/document/edit/${key}` : null

/** Storage-insensitive equality, so a value that round-tripped is not "changed". */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Absent and empty are the same thing to an editor, and the two spellings
  // travel differently: a bundle omits nothing, but the database stores null.
  const empty = (v: unknown) => v === null || v === undefined || v === ''
  if (empty(a) && empty(b)) return true
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return String(a) === String(b)
}

export async function checkBundle(
  db: Db,
  set: ContentSet,
  options: CheckOptions = {},
): Promise<TransferCheck> {
  const findings: Finding[] = []
  const plan: NodePlan[] = []
  const resolutions = options.resolutions ?? {}
  const link = (key: string) => documentLink(options.backOfficePath, key)

  // As with the exporter: read at the database's own state, or every as-of read
  // comes back empty and the check reports a clean import of nothing.
  const state = await currentSchemaState(db)
  const nodeState = { version: state.version, revision: state.revision }
  const docs = new DocumentRepository(db, { nodeState })
  const nodes = docs.nodes
  const types = new ContentTypeRepository(db)
  // Media types are a separate object type, so a repository reading document
  // types cannot see one. A bundle names its types in one flat list, without
  // saying which kind each is, so both are asked — and a media bundle stopped
  // being refused for a type the destination had all along.
  const mediaTypes = new ContentTypeRepository(db, { kind: 'media' })
  const dataTypes = new DataTypeRepository(db)

  const languages = new Set(
    (await new LanguageRepository(db).all()).map((l) => l.isoCode.toLowerCase()),
  )
  const carried = new Set(set.nodes.map((n) => n.key))

  const bundleFinding = (
    kind: Finding['kind'],
    code: string,
    message: string,
    subjectName = set.manifest.id,
  ): Finding => ({
    kind,
    code,
    subjectType: 'bundle',
    subjectKey: set.manifest.id,
    subjectName,
    propertyAlias: null,
    culture: null,
    message,
    link: null,
  })

  // Every content type the bundle names, matched by key first and alias second:
  // keys are stable across environments because tooling writes them into the
  // schema files, and the alias is what a person reads in the message.
  type Resolved = { type: Awaited<ReturnType<typeof types.byKey>>; repo: ContentTypeRepository }
  const typeByAlias = new Map<string, Resolved>()
  const declared = new Set(set.manifest.dependencies.schema.contentTypes.map((t) => t.alias))
  const typeFor = async (ct: {
    key: string
    alias: string
  }): Promise<Awaited<ReturnType<typeof types.byKey>>> => {
    const cached = typeByAlias.get(ct.alias)
    if (cached) return cached.type
    let found: Resolved = { type: undefined, repo: types }
    for (const repo of [types, mediaTypes]) {
      const type = (ct.key ? await repo.byKey(ct.key) : undefined) ?? (await repo.byAlias(ct.alias))
      if (type) {
        found = { type, repo }
        break
      }
    }
    typeByAlias.set(ct.alias, found)
    return found.type
  }
  for (const wanted of set.manifest.dependencies.schema.contentTypes) {
    if (await typeFor(wanted)) continue
    findings.push(
      bundleFinding(
        'blocking',
        'missing-content-type',
        `no content type "${wanted.alias}" here — deploy schema/ before importing`,
        wanted.alias,
      ),
    )
  }

  for (const iso of set.manifest.dependencies.schema.languages) {
    if (!languages.has(iso.toLowerCase()))
      findings.push(
        bundleFinding(
          'blocking',
          'language-missing',
          `the bundle has ${iso} content but this environment has no ${iso} language`,
          iso,
        ),
      )
  }

  // Everything the bundle expects to find already here.
  const expectedRows = new Map(
    (await nodes.byKeys(set.manifest.dependencies.expected.map((e) => e.key))).map((r) => [
      r.key,
      r,
    ]),
  )
  for (const expected of set.manifest.dependencies.expected) {
    // A re-root answers the parent case: nothing else has to exist for it.
    const isParentOnly = expected.why.startsWith('parent of')
    if (isParentOnly && options.under) continue
    const row = expectedRows.get(expected.key)
    if (row && !row.trashed) continue
    findings.push({
      kind: 'blocking',
      code: isParentOnly ? 'missing-parent' : 'missing-dependency',
      subjectType: 'bundle',
      subjectKey: expected.key,
      subjectName: expected.name || expected.key,
      propertyAlias: null,
      culture: null,
      message: row?.trashed
        ? `"${expected.name}" is in the recycle bin here, and the bundle needs it (${expected.why})`
        : `nothing here with the key ${expected.key} — the bundle needs it (${expected.why})`,
      link: link(expected.key),
    })
  }

  // The property editors each destination type actually uses, for the mismatch check.
  const editorsOf = new Map<string, Map<string, string>>()
  const editorsFor = async (alias: string): Promise<Map<string, string>> => {
    const cached = editorsOf.get(alias)
    if (cached) return cached
    const resolved = typeByAlias.get(alias)
    const editors = new Map<string, string>()
    if (resolved?.type) {
      const properties = await resolved.repo.resolveProperties(resolved.type.key)
      const byKey = new Map(
        (await dataTypes.byKeys(properties.map((p) => p.dataTypeKey))).map((d) => [
          d.key,
          d.editorAlias,
        ]),
      )
      for (const property of properties) {
        const editor = byKey.get(property.dataTypeKey)
        if (editor) editors.set(property.alias, editor)
      }
    }
    editorsOf.set(alias, editors)
    return editors
  }

  const siblingNames = new Map<string, Set<string>>()

  for (const node of set.nodes) {
    const name = node.variants[0]?.name ?? node.key
    const resolution = resolutions[node.key] ?? options.resolveAll
    const existing = await nodes.byKey(node.key)
    const editors = await editorsFor(node.contentType.alias)
    const typeMissing = !(await typeFor(node.contentType))

    if (resolution === 'skip') {
      plan.push({ key: node.key, name, kind: node.kind, action: 'skip', changing: [], resolution })
      continue
    }

    // A node whose type the manifest never declared. The loop above only
    // validates what the manifest lists, so without this a bundle whose
    // manifest and nodes disagree would import part of itself and say nothing.
    if (typeMissing && !declared.has(node.contentType.alias))
      findings.push({
        kind: 'blocking',
        code: 'missing-content-type',
        subjectType: node.kind === 'media' ? 'media' : 'document',
        subjectKey: node.key,
        subjectName: name,
        propertyAlias: null,
        culture: null,
        message: `"${name}" is a "${node.contentType.alias}", which does not exist here and the bundle never declared`,
        link: null,
      })

    for (const variant of node.variants) {
      if (variant.culture && !languages.has(variant.culture.toLowerCase()))
        findings.push({
          kind: 'blocking',
          code: 'language-missing',
          subjectType: node.kind === 'media' ? 'media' : 'document',
          subjectKey: node.key,
          subjectName: name,
          propertyAlias: null,
          culture: variant.culture,
          message: `"${name}" has ${variant.culture} content and this environment has no ${variant.culture} language`,
          link: link(node.key),
        })
    }

    // A template's definition is its file, so the alias travels and the view
    // has to be there. Missing one is not fatal — the page imports without a
    // template and renders nothing until the view is deployed.
    if (node.template && options.templateAliases && !options.templateAliases.has(node.template))
      findings.push({
        kind: 'auto',
        code: 'missing-template',
        subjectType: 'document',
        subjectKey: node.key,
        subjectName: name,
        propertyAlias: null,
        culture: null,
        message: `no view Views/${node.template}.tsx here, so "${name}" arrives without a template`,
        link: link(node.key),
      })

    // Properties the destination type no longer has, and editors that changed
    // under them. A retired property is a value the import drops; a changed
    // editor is a value it would store in the wrong shape, so that one blocks.
    if (!typeMissing) {
      for (const value of node.values) {
        const editor = editors.get(value.property)
        if (editor === undefined) {
          findings.push({
            kind: 'auto',
            code: 'missing-property',
            subjectType: node.kind === 'media' ? 'media' : 'document',
            subjectKey: node.key,
            subjectName: name,
            propertyAlias: value.property,
            culture: value.culture,
            message: `"${node.contentType.alias}" has no property "${value.property}" here, so its value is not imported`,
            link: link(node.key),
          })
          continue
        }
        if (value.editor && editor !== value.editor)
          findings.push({
            kind: 'blocking',
            code: 'editor-mismatch',
            subjectType: node.kind === 'media' ? 'media' : 'document',
            subjectKey: node.key,
            subjectName: name,
            propertyAlias: value.property,
            culture: value.culture,
            message: `"${value.property}" was ${value.editor} where the bundle was made and is ${editor} here`,
            link: link(node.key),
          })
      }
    }

    // References inside values that resolve to nothing here and are not carried.
    const referenced = new Set<string>()
    for (const value of node.values)
      for (const key of value.references ?? referenceCandidates(value.value)) referenced.add(key)
    const outside = [...referenced].filter((key) => !carried.has(key))
    const present = new Set((await nodes.byKeys(outside)).map((r) => r.key))
    for (const key of outside) {
      if (present.has(key)) continue
      // Only report what the bundle itself said was a reference. A candidate
      // the exporter never resolved was never a reference.
      if (!set.manifest.dependencies.expected.some((e) => e.key === key)) continue
      findings.push({
        kind: 'person',
        code: 'unresolved-reference',
        subjectType: node.kind === 'media' ? 'media' : 'document',
        subjectKey: node.key,
        subjectName: name,
        propertyAlias: null,
        culture: null,
        message: `a value on "${name}" refers to ${key}, which is not here and not in the bundle`,
        link: link(node.key),
      })
    }

    if (node.kind === 'media' && options.hasBlob && !options.allowMissingBlobs) {
      for (const blob of set.manifest.blobs.filter((b) => b.node === node.key)) {
        if (blob.included || (await options.hasBlob(blob.key))) continue
        findings.push({
          kind: 'person',
          code: 'missing-blob',
          subjectType: 'media',
          subjectKey: node.key,
          subjectName: name,
          propertyAlias: null,
          culture: null,
          message: `the file "${blob.key}" for "${name}" is not in this environment's media store`,
          link: null,
        })
      }
    }

    if (!existing) {
      // A sibling of the same name is a URL clash, which is a person's call.
      const parentKey = options.under?.key ?? node.parent
      const siblings =
        siblingNames.get(parentKey ?? '') ??
        new Set(
          (
            await nodes.childrenNamed(
              parentKey ? ((await nodes.byKey(parentKey))?.id ?? 0) : -1,
              [ObjectTypes.Document, ObjectTypes.Media, ObjectTypes.Element],
              name,
            )
          ).map((r) => r.text ?? ''),
        )
      siblingNames.set(parentKey ?? '', siblings)
      if (siblings.has(name))
        findings.push({
          kind: 'person',
          code: 'name-collision',
          subjectType: node.kind === 'media' ? 'media' : 'document',
          subjectKey: node.key,
          subjectName: name,
          propertyAlias: null,
          culture: null,
          message: `something called "${name}" is already here, so the two would share a URL`,
          link: null,
        })
      plan.push({
        key: node.key,
        name,
        kind: node.kind,
        action: 'create',
        changing: node.values.map((v) => v.property),
        resolution,
      })
      findings.push({
        kind: 'auto',
        code: 'new-node',
        subjectType: node.kind === 'media' ? 'media' : 'document',
        subjectKey: node.key,
        subjectName: name,
        propertyAlias: null,
        culture: null,
        message:
          node.kind === 'media'
            ? `"${name}" is new here and media is live as soon as it lands`
            : `"${name}" is new here and arrives as a draft`,
        link: null,
      })
      continue
    }

    if (existing.trashed) {
      findings.push({
        kind: 'blocking',
        code: 'local-trashed',
        subjectType: node.kind === 'media' ? 'media' : 'document',
        subjectKey: node.key,
        subjectName: name,
        propertyAlias: null,
        culture: null,
        message: `"${name}" is in the recycle bin here; importing over it would revive it silently`,
        link: link(node.key),
      })
      plan.push({ key: node.key, name, kind: node.kind, action: 'skip', changing: [], resolution })
      continue
    }

    // What the bundle would actually change, property by property.
    const current = await docs.byKey(node.key)
    const currentByKey = new Map(
      (current?.values ?? []).map((v) => [`${v.alias}|${v.culture ?? ''}|${v.segment ?? ''}`, v]),
    )
    const changing = node.values
      .filter((value) => {
        if (!editors.has(value.property)) return false
        const mine = currentByKey.get(
          `${value.property}|${value.culture ?? ''}|${value.segment ?? ''}`,
        )
        return !sameValue(mine?.value, value.value)
      })
      .map((value) => value.property)

    if (changing.length === 0) {
      plan.push({
        key: node.key,
        name,
        kind: node.kind,
        action: 'unchanged',
        changing: [],
        resolution,
      })
      continue
    }

    // It exists, and the bundle disagrees with it. We cannot know whether
    // somebody edited it here or the bundle is simply newer, so this is a
    // decision rather than a defect — and it is the one an import waits on.
    if (resolution === undefined)
      findings.push({
        kind: 'person',
        code: 'local-edit',
        subjectType: node.kind === 'media' ? 'media' : 'document',
        subjectKey: node.key,
        subjectName: name,
        propertyAlias: null,
        culture: null,
        message: `"${name}" is already here and differs: the bundle would replace ${changing.join(', ')}`,
        link: link(node.key),
      })
    plan.push({
      key: node.key,
      name,
      kind: node.kind,
      action: resolution === 'keep-local' ? 'unchanged' : 'update',
      changing,
      resolution,
    })
  }

  const counts = { create: 0, update: 0, unchanged: 0, skip: 0 }
  for (const entry of plan) counts[entry.action] += 1

  return {
    bundleId: set.manifest.id,
    findings,
    // `auto` is what the import will do; it never holds one up.
    outstanding: findings.filter((f) => f.kind === 'blocking' || f.kind === 'person'),
    plan,
    counts,
  }
}
