/**
 * Database → bundle.
 *
 * Reads the selected subtrees through `DocumentRepository`'s own public reads,
 * so the values a bundle carries are exactly the values the site would serve or
 * show, converters and culture handling included.
 *
 * The snapshot rule: a published node carries its **published** values, because
 * a bundle should hold what the source site actually serves; an unpublished one
 * carries its draft and says so. `--drafts` takes the current draft throughout,
 * for the case where the point is to move work in progress.
 */
import type { DocumentAggregate, DocumentValue } from '@bunbraco/core'
import { ObjectTypes } from '@bunbraco/core'
import {
  ComponentRepository,
  type ContentKind,
  currentSchemaState,
  type Db,
  DocumentRepository,
  type NodeRow,
} from '@bunbraco/data'
import {
  BUNDLE_FORMAT_VERSION,
  type BundleBlob,
  type BundleDependency,
  type BundleKind,
  type BundleNode,
  type BundleSnapshot,
  type BundleValue,
  type ContentSet,
} from './model.ts'
import { referenceCandidates } from './references.ts'

/** The kinds a bundle carries, and the repository kind each reads through. */
const KINDS: Record<BundleKind, { objectType: string; contentKind: ContentKind }> = {
  document: { objectType: ObjectTypes.Document, contentKind: 'document' },
  media: { objectType: ObjectTypes.Media, contentKind: 'media' },
  element: { objectType: ObjectTypes.Element, contentKind: 'element' },
  blueprint: { objectType: ObjectTypes.DocumentBlueprint, contentKind: 'blueprint' },
}

/** Editors that hold a file rather than a reference to one. */
const FILE_EDITORS = new Set(['Umbraco.ImageCropper', 'Umbraco.UploadField'])

export interface ExportOptions {
  /** Resolved subtree roots, by key. */
  roots: readonly NodeRow[]
  /** What was typed, kept for the manifest. */
  asGiven: readonly string[]
  descendants: boolean
  snapshot: BundleSnapshot
  /** Include blueprints reached from the selection. */
  blueprints: boolean
  /**
   * Whether the bundle is to carry its media files.
   *
   * The bytes are not read here: where media lives is the store's business, and
   * this package knows nothing about it. The keys come back in `blobKeys`
   * whatever this says, and the writer decides `included` from the bytes the
   * caller actually managed to read.
   */
  withBlobs: boolean
  siteName: string
  nodeId: string
}

export interface ExportResult {
  set: ContentSet
  /** Media store keys the caller should copy when `withBlobs` is set. */
  blobKeys: string[]
}

/**
 * `/media/ab12cd34/photo.jpg` → `ab12cd34/photo.jpg`, the store's own key.
 * `MediaFiles.key` does this in `@bunbraco/server`, but the prefix is a URL
 * convention rather than store behaviour and this package must not depend on
 * the composition root to read it.
 */
function storeKey(src: unknown): string | undefined {
  const text = typeof src === 'string' ? src : undefined
  if (!text) return undefined
  const match = /^\/?media\/(.+)$/.exec(text)
  return match?.[1]
}

function blobKeysOf(values: readonly DocumentValue[]): string[] {
  const found: string[] = []
  for (const value of values) {
    if (!value.editorAlias || !FILE_EDITORS.has(value.editorAlias)) continue
    const raw = value.value
    const src =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>).src
          : undefined
    const key = storeKey(src)
    if (key) found.push(key)
  }
  return found
}

function toBundleValue(value: DocumentValue, references: readonly string[]): BundleValue {
  return {
    property: value.alias,
    culture: value.culture,
    segment: value.segment,
    editor: value.editorAlias ?? '',
    value: value.value,
    references: references.length > 0 ? [...references] : undefined,
  }
}

function toBundleNode(
  node: NodeRow,
  kind: BundleKind,
  aggregate: DocumentAggregate,
  parentKeyByNodeId: (id: number) => string | null,
  componentAlias: string | null,
  candidates: Map<DocumentValue, string[]>,
): BundleNode {
  return {
    key: node.key,
    kind,
    contentType: { key: aggregate.contentTypeKey, alias: aggregate.contentTypeAlias },
    parent: parentKeyByNodeId(node.parentId),
    sortOrder: node.sortOrder,
    template: componentAlias,
    variants: aggregate.variants.map((v) => ({
      culture: v.culture,
      segment: v.segment,
      name: v.name,
      published: v.state === 'Published' || v.state === 'PublishedPendingChanges',
    })),
    values: aggregate.values.map((v) => toBundleValue(v, candidates.get(v) ?? [])),
  }
}

/** Every node of the selection, roots first and parents before children. */
async function selected(
  db: Db,
  options: ExportOptions,
): Promise<Array<{ node: NodeRow; kind: BundleKind }>> {
  const byKind = new Map<string, BundleKind>(
    Object.entries(KINDS).map(([kind, v]) => [v.objectType, kind as BundleKind]),
  )
  const wanted: string[] = [ObjectTypes.Document, ObjectTypes.Media, ObjectTypes.Element]
  if (options.blueprints) wanted.push(ObjectTypes.DocumentBlueprint)

  const found = new Map<number, { node: NodeRow; kind: BundleKind }>()
  const nodes = new DocumentRepository(db).nodes
  for (const root of options.roots) {
    const kind = byKind.get(root.objectType ?? '')
    if (kind) found.set(root.id, { node: root, kind })
    if (!options.descendants) continue
    for (const descendant of await nodes.descendants(root, wanted)) {
      const k = byKind.get(descendant.objectType ?? '')
      if (k) found.set(descendant.id, { node: descendant, kind: k })
    }
  }
  return [...found.values()].sort((a, b) => a.node.level - b.node.level || a.node.id - b.node.id)
}

export async function exportBundle(db: Db, options: ExportOptions): Promise<ExportResult> {
  const chosen = await selected(db, options)

  /**
   * Read at the state the database is at, not at the repository's default.
   *
   * A repository constructed without a `nodeState` runs at the install
   * baseline, and reads are as-of that state — so `visibleStateIdFor` finds no
   * state row at or below it and every value is filtered out. The export then
   * succeeds and carries nothing, which is the worst possible failure. A tool
   * reading content is not a node asserting a deployment; it takes the
   * database's own state.
   */
  const state = await currentSchemaState(db)
  const nodeState = { version: state.version, revision: state.revision }

  const repos = new Map<ContentKind, DocumentRepository>()
  const repoFor = (kind: BundleKind): DocumentRepository => {
    const contentKind = KINDS[kind].contentKind
    const existing = repos.get(contentKind)
    if (existing) return existing
    const repo = new DocumentRepository(db, { kind: contentKind, nodeState })
    repos.set(contentKind, repo)
    return repo
  }

  const nodes = new DocumentRepository(db).nodes
  const templateRepo = new ComponentRepository(db)
  const keyOfNodeId = new Map<number, string>()
  for (const { node } of chosen) keyOfNodeId.set(node.id, node.key)

  const bundleNodes: BundleNode[] = []
  const blobs: BundleBlob[] = []
  const referenced = new Set<string>()
  const contentTypes = new Map<string, string>()
  const templates = new Set<string>()
  const languages = new Set<string>()
  const counts: Partial<Record<BundleKind, number>> = {}

  for (const { node, kind } of chosen) {
    const repo = repoFor(kind)
    // Media is never published, so there is no published snapshot to prefer.
    const published =
      options.snapshot === 'published' && kind !== 'media'
        ? await repo.byKeyPublished(node.key)
        : undefined
    const aggregate = published ?? (await repo.byKey(node.key))
    if (!aggregate) continue

    const candidates = new Map<DocumentValue, string[]>()
    for (const value of aggregate.values) {
      const keys = referenceCandidates(value.value)
      if (keys.length > 0) candidates.set(value, keys)
      for (const key of keys) referenced.add(key)
    }

    // The parent travels as a key only when it is in the bundle; otherwise it is
    // an expected dependency, which the destination must already have. The
    // system containers — the tree root and the recycle bins — have real `node`
    // rows with keys of their own, and a node sitting under one has no parent as
    // far as a bundle is concerned.
    const parentKey =
      node.parentId <= 0
        ? null
        : (keyOfNodeId.get(node.parentId) ?? (await nodes.byId(node.parentId))?.key ?? null)
    // A template's definition is its file, so the alias travels and the key does
    // not: the same view has a different key in every environment.
    const componentAlias = aggregate.componentKey
      ? ((await templateRepo.byKey(aggregate.componentKey))?.alias ?? null)
      : null

    bundleNodes.push(
      toBundleNode(node, kind, aggregate, () => parentKey, componentAlias, candidates),
    )
    counts[kind] = (counts[kind] ?? 0) + 1
    contentTypes.set(aggregate.contentTypeAlias, aggregate.contentTypeKey)
    if (componentAlias) templates.add(componentAlias)
    for (const variant of aggregate.variants) if (variant.culture) languages.add(variant.culture)
    if (kind === 'media')
      for (const key of blobKeysOf(aggregate.values))
        blobs.push({ key, node: node.key, etag: null, size: null, included: false })
  }

  const carried = new Set(bundleNodes.map((n) => n.key))

  // Anything referenced or parented that the bundle does not carry must already
  // exist at the destination. A candidate that resolves to no node here was
  // never a reference — an undashed uuid is indistinguishable from any other 32
  // hex characters — so it is dropped rather than demanded.
  const outside = [...referenced].filter((key) => !carried.has(key))
  const expected: BundleDependency[] = []
  for (const row of await nodes.byKeys(outside)) {
    expected.push({
      key: row.key,
      objectType: row.objectType ?? '',
      name: row.text ?? '',
      why: 'referenced by a value in this bundle',
    })
  }
  for (const node of bundleNodes) {
    if (!node.parent || carried.has(node.parent)) continue
    if (expected.some((e) => e.key === node.parent)) continue
    const row = await nodes.byKey(node.parent)
    if (row)
      expected.push({
        key: row.key,
        objectType: row.objectType ?? '',
        name: row.text ?? '',
        why: `parent of ${node.variants[0]?.name ?? node.key}`,
      })
  }

  return {
    set: {
      manifest: {
        formatVersion: BUNDLE_FORMAT_VERSION,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        createdBy: options.nodeId,
        // writeBundle recomputes this over the node files it emits.
        integrity: '',
        snapshot: options.snapshot,
        provenance: {
          siteName: options.siteName,
          schemaVersion: state.version,
          schemaRevision: state.revision,
          schemaHash: state.hash,
        },
        selector: {
          roots: options.roots.map((r) => r.key),
          descendants: options.descendants,
          asGiven: [...options.asGiven],
        },
        counts,
        dependencies: {
          carried: [...carried],
          expected,
          schema: {
            contentTypes: [...contentTypes].map(([alias, key]) => ({ key, alias })),
            components: [...templates],
            languages: [...languages],
          },
        },
        blobs,
      },
      nodes: bundleNodes,
    },
    // Every key, carried or not: a caller that is not carrying them still has
    // to be able to say how many files this bundle expects to find elsewhere.
    blobKeys: [...new Set(blobs.map((b) => b.key))],
  }
}
