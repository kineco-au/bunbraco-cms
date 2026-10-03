/**
 * Umbraco's content → a bundle, the artifact `content export` writes and
 * `content import` already knows how to apply.
 *
 * The snapshot rule is the exporter's: a published page carries its published
 * values, an unpublished one its draft, and `drafts` takes the draft throughout.
 */
import { ObjectTypes, toEditorValue } from '@bunbraco/core'
import { hashSchemaSet } from '@bunbraco/schema'
import {
  BUNDLE_FORMAT_VERSION,
  type BundleBlob,
  type BundleKind,
  type BundleNode,
  type BundleSnapshot,
  type BundleValue,
  type BundleVariant,
  type ContentSet,
  referenceCandidates,
} from '@bunbraco/transfer'
import type { Findings } from './findings.ts'
import type { ConvertedSchema } from './schema.ts'
import { key, type Source, wallClock } from './source.ts'

const KIND_OF: Record<string, BundleKind> = {
  [ObjectTypes.Document]: 'document',
  [ObjectTypes.Media]: 'media',
  [ObjectTypes.Element]: 'element',
  [ObjectTypes.DocumentBlueprint]: 'blueprint',
}

/** Editors that hold a file rather than a reference to one. */
const FILE_EDITORS = new Set(['Umbraco.ImageCropper', 'Umbraco.UploadField'])

const COLUMN_OF: Record<string, ValueColumn> = {
  Integer: 'intValue',
  Decimal: 'decimalValue',
  Date: 'dateValue',
  Nvarchar: 'varcharValue',
  Ntext: 'textValue',
}
type ValueColumn = 'intValue' | 'decimalValue' | 'dateValue' | 'varcharValue' | 'textValue'
const COLUMNS: readonly ValueColumn[] = [
  'textValue',
  'varcharValue',
  'intValue',
  'decimalValue',
  'dateValue',
]

export interface ConvertContentOptions {
  snapshot: BundleSnapshot
  siteName: string
}

export interface SourceBlob {
  /** The media store key: `ab12cd34/photo.jpg`. */
  key: string
  /** The media node that names it. */
  node: string
  name: string
}

export interface ConvertedContent {
  set: ContentSet
  blobs: SourceBlob[]
}

const truthy = (value: unknown): boolean => value === 1 || value === true || value === '1'

/** `/media/ab12cd34/photo.jpg` → `ab12cd34/photo.jpg`. */
export function storeKey(src: unknown): string | undefined {
  if (typeof src !== 'string') return undefined
  return /^\/?media\/(.+)$/.exec(src.split('?')[0] as string)?.[1]
}

function blobKeyOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (value.trimStart().startsWith('{')) {
      try {
        return blobKeyOf(JSON.parse(value))
      } catch {
        return undefined
      }
    }
    return storeKey(value)
  }
  if (typeof value === 'object' && value !== null)
    return storeKey((value as Record<string, unknown>).src)
  return undefined
}

type ValueRow = {
  versionId: number
  propertyTypeId: number
  languageId: number | null
  segment: string | null
} & Record<ValueColumn, unknown>

/** What the editor would be handed for a stored cell. */
function editorValue(editor: string, dbType: string, row: ValueRow): unknown {
  // The declared column first; an older database may still hold the value in
  // another, as checkbox lists did before 17 moved them.
  const declared = COLUMN_OF[dbType]
  const column =
    declared && row[declared] !== null && row[declared] !== undefined
      ? declared
      : COLUMNS.find((c) => row[c] !== null && row[c] !== undefined)
  if (!column) return null
  const raw = row[column]
  switch (column) {
    case 'dateValue':
      // Wall-clock time, as the date pickers store and show it.
      return wallClock(raw)
    case 'decimalValue':
      return Number(raw)
    case 'intValue':
      return editor === 'Umbraco.TrueFalse' ? truthy(raw) : Number(raw)
    default:
      return toEditorValue(editor, raw)
  }
}

export function convertContent(
  source: Source,
  schema: ConvertedSchema,
  findings: Findings,
  options: ConvertContentOptions,
): ConvertedContent {
  const nodes = source
    .all<{
      id: number
      key: string
      parentId: number
      level: number
      sortOrder: number
      trashed: unknown
      name: string | null
      objectType: string
      contentTypeId: number
    }>(
      `SELECT n.id AS id, n.uniqueId AS key, n.parentId AS parentId, n.level AS level,
              n.sortOrder AS sortOrder, n.trashed AS trashed, n."text" AS name,
              n.nodeObjectType AS objectType, c.contentTypeId AS contentTypeId
       FROM umbracoNode n JOIN umbracoContent c ON c.nodeId = n.id
       ORDER BY n.level, n.sortOrder, n.id`,
    )
    .filter((row) => KIND_OF[key(row.objectType)] !== undefined)

  const live = nodes.filter((row) => !truthy(row.trashed))
  const carriedIds = new Map(live.map((row) => [Number(row.id), key(row.key)]))
  const carriedKeys = new Set(carriedIds.values())
  const everyKey = new Set(
    source.all<{ key: string }>('SELECT uniqueId AS key FROM umbracoNode').map((r) => key(r.key)),
  )

  // Published state, per kind that has one.
  const state = new Map<number, { published: boolean; edited: boolean }>()
  const readState = (table: string) => {
    if (!source.has(table)) return
    for (const row of source.all<{ nodeId: number; published: unknown; edited: unknown }>(
      `SELECT nodeId, published, edited FROM ${table}`,
    ))
      state.set(Number(row.nodeId), {
        published: truthy(row.published),
        edited: truthy(row.edited),
      })
  }
  readState('umbracoDocument')
  readState('umbracoElement')

  // The current and the published version of every node.
  const elementVersions = source.has('umbracoElementVersion')
  const versions = source.all<{
    id: number
    nodeId: number
    current: unknown
    name: string | null
    published: unknown
    templateId: number | null
    elementPublished?: unknown
  }>(
    `SELECT cv.id AS id, cv.nodeId AS nodeId, cv."current" AS current, cv."text" AS name,
            dv.published AS published, dv.templateId AS templateId
            ${elementVersions ? ', ev.published AS elementPublished' : ''}
     FROM umbracoContentVersion cv
     LEFT JOIN umbracoDocumentVersion dv ON dv.id = cv.id
     ${elementVersions ? 'LEFT JOIN umbracoElementVersion ev ON ev.id = cv.id' : ''}
     WHERE cv."current" = 1 OR dv.published = 1 ${elementVersions ? 'OR ev.published = 1' : ''}`,
  )
  const currentOf = new Map<number, (typeof versions)[number]>()
  const publishedOf = new Map<number, (typeof versions)[number]>()
  for (const version of versions) {
    if (truthy(version.current)) currentOf.set(Number(version.nodeId), version)
    if (truthy(version.published) || truthy(version.elementPublished))
      publishedOf.set(Number(version.nodeId), version)
  }

  // Which version each node travels as.
  const chosen = new Map<number, (typeof versions)[number]>()
  let pendingChanges = 0
  for (const row of live) {
    const id = Number(row.id)
    const nodeState = state.get(id)
    const published = nodeState?.published ? publishedOf.get(id) : undefined
    if (published && nodeState?.edited && options.snapshot === 'published') pendingChanges++
    const version =
      options.snapshot === 'published' && published ? published : (currentOf.get(id) ?? published)
    if (version) chosen.set(id, version)
  }
  const versionIds = new Set([...chosen.values()].map((v) => Number(v.id)))

  const valuesByVersion = new Map<number, ValueRow[]>()
  for (const row of source.all<ValueRow>(
    `SELECT versionId, propertyTypeId, languageId, segment, intValue, decimalValue, dateValue,
            varcharValue, textValue FROM umbracoPropertyData`,
  )) {
    const versionId = Number(row.versionId)
    if (!versionIds.has(versionId)) continue
    const list = valuesByVersion.get(versionId) ?? []
    list.push(row)
    valuesByVersion.set(versionId, list)
  }

  // Culture variants.
  const cultureRows = source.has('umbracoDocumentCultureVariation')
    ? source.all<{
        nodeId: number
        languageId: number
        available: unknown
        published: unknown
        name: string | null
      }>(
        'SELECT nodeId, languageId, available, published, name FROM umbracoDocumentCultureVariation',
      )
    : []
  const versionNames = new Map<string, string>()
  if (source.has('umbracoContentVersionCultureVariation'))
    for (const row of source.all<{ versionId: number; languageId: number; name: string | null }>(
      'SELECT versionId, languageId, name FROM umbracoContentVersionCultureVariation',
    ))
      if (row.name) versionNames.set(`${row.versionId}:${row.languageId}`, row.name)

  const bundleNodes: BundleNode[] = []
  const blobs: SourceBlob[] = []
  const counts: Partial<Record<BundleKind, number>> = {}
  const usedTypes = new Map<string, string>()
  const usedTemplates = new Set<string>()
  const usedLanguages = new Set<string>()
  const dangling = new Set<string>()
  let unknownType = 0

  for (const row of live) {
    const id = Number(row.id)
    const kind = KIND_OF[key(row.objectType)] as BundleKind
    const contentType = schema.contentTypes.get(Number(row.contentTypeId))
    const version = chosen.get(id)
    if (!contentType || !version) {
      unknownType++
      carriedKeys.delete(key(row.key))
      carriedIds.delete(id)
      continue
    }
    const nodeState = state.get(id)
    const isPublished = kind !== 'media' && (nodeState?.published ?? false)

    const variants: BundleVariant[] = []
    const cultures = contentType.variesByCulture
      ? cultureRows.filter((c) => Number(c.nodeId) === id && truthy(c.available))
      : []
    for (const culture of cultures) {
      const iso = schema.languages.get(Number(culture.languageId))?.iso
      if (!iso) continue
      usedLanguages.add(iso)
      variants.push({
        culture: iso,
        segment: null,
        name:
          versionNames.get(`${version.id}:${culture.languageId}`) ?? culture.name ?? row.name ?? '',
        published: isPublished && truthy(culture.published),
      })
    }
    if (variants.length === 0)
      variants.push({
        culture: null,
        segment: null,
        name: version.name ?? row.name ?? '',
        published: isPublished,
      })

    const values: BundleValue[] = []
    for (const cell of valuesByVersion.get(Number(version.id)) ?? []) {
      const property = schema.propertyTypes.get(Number(cell.propertyTypeId))
      if (!property) continue
      const { editor, dbType } = property.dataType
      const value = editorValue(editor, dbType, cell)
      if (value === null || value === undefined) continue
      const culture =
        cell.languageId === null
          ? null
          : (schema.languages.get(Number(cell.languageId))?.iso ?? null)
      if (culture) usedLanguages.add(culture)

      // Only what the bundle carries is a reference the destination can honour.
      const references: string[] = []
      for (const candidate of referenceCandidates(value)) {
        if (candidate === key(row.key)) continue
        if (carriedKeys.has(candidate)) references.push(candidate)
        else if (everyKey.has(candidate)) dangling.add(candidate)
      }
      values.push({
        property: property.alias,
        culture,
        segment: cell.segment ?? null,
        editor,
        value,
        references: references.length > 0 ? references : undefined,
      })

      if (kind === 'media' && FILE_EDITORS.has(editor)) {
        const blob = blobKeyOf(value)
        if (blob) blobs.push({ key: blob, node: key(row.key), name: row.name ?? blob })
      }
    }

    const template =
      kind === 'document' && version.templateId !== null
        ? (schema.templates.get(Number(version.templateId))?.alias ?? null)
        : null
    if (template) usedTemplates.add(template)
    usedTypes.set(contentType.alias, contentType.key)
    counts[kind] = (counts[kind] ?? 0) + 1

    bundleNodes.push({
      key: key(row.key),
      kind,
      contentType: { key: contentType.key, alias: contentType.alias },
      parent: carriedIds.get(Number(row.parentId)) ?? null,
      sortOrder: Number(row.sortOrder),
      template,
      variants,
      values,
    })
  }

  const bundleBlobs: BundleBlob[] = blobs.map((blob) => ({
    key: blob.key,
    node: blob.node,
    etag: null,
    size: null,
    included: false,
  }))

  const totalVersions = source.count('umbracoContentVersion')
  findings.add({
    class: 'migrates',
    code: 'content',
    title: 'Content',
    count: bundleNodes.length,
    detail: (['document', 'media', 'element', 'blueprint'] as const)
      .filter((kind) => counts[kind])
      .map((kind) => `${counts[kind]} ${kind}${kind === 'media' ? '' : 's'}`)
      .join(', '),
  })
  findings.some({
    class: 'dropped',
    code: 'pending-changes',
    title: 'Published pages with unpublished changes',
    detail:
      'The published version of each is imported, as that is what the site serves. Run with --drafts to take the working copy instead.',
    count: pendingChanges,
  })
  findings.some({
    class: 'dropped',
    code: 'version-history',
    title: 'Earlier versions',
    detail: 'Only what is published and the current draft travel; version history does not.',
    count: Math.max(0, totalVersions - versionIds.size),
  })
  findings.some({
    class: 'dropped',
    code: 'recycle-bin',
    title: 'Items in the recycle bin',
    count: nodes.length - live.length,
  })
  findings.some({
    class: 'dropped',
    code: 'unknown-content-type',
    title: 'Content whose type could not be read',
    count: unknownType,
  })
  findings.some({
    class: 'needs-a-person',
    code: 'dangling-references',
    title: 'Pickers that point at something not being imported',
    detail:
      'A value refers to a member, a recycled item or another node that does not travel. The value is carried as it is, and the picker will show it as missing.',
    count: dangling.size,
  })

  const roots = bundleNodes.filter((node) => node.parent === null).map((node) => node.key)
  return {
    blobs,
    set: {
      manifest: {
        formatVersion: BUNDLE_FORMAT_VERSION,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        createdBy: 'bunbraco import umbraco',
        // writeBundle recomputes this over the files it emits.
        integrity: '',
        snapshot: options.snapshot,
        provenance: {
          siteName: options.siteName,
          schemaVersion: schema.set.version,
          schemaRevision: '0',
          schemaHash: hashSchemaSet(schema.set),
        },
        selector: { roots, descendants: true, asGiven: ['umbraco'] },
        counts,
        dependencies: {
          carried: bundleNodes.map((node) => node.key),
          expected: [],
          schema: {
            contentTypes: [...usedTypes].map(([alias, typeKey]) => ({ key: typeKey, alias })),
            templates: [...usedTemplates],
            languages: [...usedLanguages],
          },
        },
        blobs: bundleBlobs,
      },
      nodes: bundleNodes,
    },
  }
}
