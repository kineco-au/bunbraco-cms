/**
 * Bundles: the definitions, and the npm package a download builds from one.
 * `docs/bundles.md`.
 *
 * Nothing new is serialized here. Schema travels as the canonical TOML
 * `@crombolo/schema` already writes, content and media as the bundle
 * `@crombolo/transfer` already exports, files as themselves, and dictionary
 * items as the `.udt` the dictionary already exports. The build is composition,
 * which is why a bundle can carry everything the builder UI offers.
 */
import {
  type BuiltPackage,
  type FileSystemPort,
  type PackageDefinition,
  type PackageDefinitionInput,
  type PackagePort,
  type PackageWriteResult,
  packageFileName,
} from '@crombolo/api-management'
import { ObjectTypes, type Page } from '@crombolo/core'
import {
  type Bundle,
  BundleRepository,
  type ComponentFileStore,
  type Db,
  type NodeRow,
  resolveNodeRef,
} from '@crombolo/data'
import {
  type BundleBlob,
  type BundleDependency,
  type BundleKind,
  type BundleNode,
  bundleIdFor,
  bundlePeerRange,
  type ContentSet,
  exportBundle,
  isPackageName,
  packageNameFor,
  writeBundle,
  writeBundlePackage,
} from '@crombolo/transfer'
import { VERSION } from '../config.ts'
import { readBlobs } from '../media-files.ts'
import type { MediaStore } from '../media-store.ts'
import { siteSections } from '../site-sections.ts'
import { writeNpmTarball } from '../tar.ts'

/** The npm package a definition is built as: what was set on it, or what its name gives. */
export function bundlePackageOf(row: Bundle): { name: string; version: string } {
  return {
    name: row.packageName ?? packageNameFor(row.name),
    version: row.packageVersion ?? '1.0.0',
  }
}

/** The content kinds a bundle's picks can name. */
const CONTENT_OBJECT_TYPES = [ObjectTypes.Document, ObjectTypes.Media, ObjectTypes.Element]

export interface PackagePortOptions {
  siteName: string
  nodeId: string
  marketplaceUrl: string
  /** Reads a template's view, which lives on disk rather than in the row. */
  componentFiles: ComponentFileStore
  mediaStore: MediaStore
  components?: FileSystemPort
  stylesheets?: FileSystemPort
  scripts?: FileSystemPort
}

const definition = (row: Bundle): PackageDefinition => ({
  id: row.id,
  name: row.name,
  contentNodeId: row.contentNodeId,
  contentLoadChildNodes: row.contentLoadChildNodes,
  mediaIds: row.mediaIds,
  mediaLoadChildNodes: row.mediaLoadChildNodes,
  elementIds: row.elementIds,
  contentTypes: row.contentTypes,
  mediaTypes: row.mediaTypes,
  dataTypes: row.dataTypes,
  // The wire format is Umbraco's, and it still has two fields. There is one
  // list on this side, so it answers as `templates` and `partialViews` is
  // always empty — the split is a property of the contract, not of the data.
  templates: row.components,
  partialViews: [],
  stylesheets: row.stylesheets,
  scripts: row.scripts,
  languages: row.languages,
  dictionaryItems: row.dictionaryItems,
})

/**
 * The contract's two lists, stored as the one this side has.
 *
 * `templates` and `partialViews` are both components; which tree the backoffice
 * picked one from is not something worth keeping.
 */
const stored = <T extends PackageDefinitionInput>(input: T) => ({
  ...input,
  components: [...input.templates, ...input.partialViews],
})

/**
 * Several exports as one bundle: the nodes deduped by key, the counts summed,
 * and the dependencies and selector unioned, so the manifest describes what the
 * bundle actually holds rather than what one of the exports held. `writeBundle`
 * recomputes the integrity hash over the files it writes.
 */
function mergeContentSets(sets: readonly ContentSet[]): ContentSet | undefined {
  const [first, ...rest] = sets
  if (!first) return undefined
  if (rest.length === 0) return first

  const nodes = new Map<string, BundleNode>()
  for (const set of sets) for (const node of set.nodes) nodes.set(node.key, node)

  const counts: Partial<Record<BundleKind, number>> = {}
  for (const node of nodes.values()) counts[node.kind] = (counts[node.kind] ?? 0) + 1

  const expected = new Map<string, BundleDependency>()
  const blobs = new Map<string, BundleBlob>()
  const carried = new Set<string>()
  const contentTypes = new Map<string, { key: string; alias: string }>()
  const components = new Set<string>()
  const languages = new Set<string>()
  const roots: string[] = []
  const asGiven: string[] = []
  for (const set of sets) {
    for (const dependency of set.manifest.dependencies.expected)
      expected.set(dependency.key, dependency)
    for (const key of set.manifest.dependencies.carried) carried.add(key)
    for (const type of set.manifest.dependencies.schema.contentTypes)
      contentTypes.set(type.key, type)
    for (const alias of set.manifest.dependencies.schema.components) components.add(alias)
    for (const iso of set.manifest.dependencies.schema.languages) languages.add(iso)
    for (const blob of set.manifest.blobs) blobs.set(blob.key, blob)
    roots.push(...set.manifest.selector.roots)
    asGiven.push(...set.manifest.selector.asGiven)
  }

  return {
    nodes: [...nodes.values()],
    manifest: {
      ...first.manifest,
      counts,
      // True of the merged set: a group that asked for descendants is already
      // expanded into its nodes, so the flag has done its work.
      selector: { roots, asGiven, descendants: sets.some((s) => s.manifest.selector.descendants) },
      dependencies: {
        carried: [...carried],
        expected: [...expected.values()],
        schema: {
          contentTypes: [...contentTypes.values()],
          components: [...components],
          languages: [...languages],
        },
      },
      blobs: [...blobs.values()],
    },
  }
}

export function createPackagePort(db: Db, options: PackagePortOptions): PackagePort {
  const bundles = new BundleRepository(db)

  const validate = (input: PackageDefinitionInput): PackageWriteResult | undefined =>
    input.name.length === 0 ? { ok: false, status: 'InvalidName' } : undefined

  /**
   * The content, media and element picks as one transfer bundle, blobs included.
   *
   * Three groups, not one: the contract carries `contentLoadChildNodes` and
   * `mediaLoadChildNodes` as separate booleans, and elements have no such flag
   * at all. `descendants` is per export, so a definition whose two flags
   * disagree needs an export each — otherwise picking a media folder's children
   * would quietly drag a content page's children in too. The sets are merged
   * back into one bundle, which is what the destination reads.
   */
  const contentEntries = async (
    from: PackageDefinition,
  ): Promise<{ set: ContentSet | undefined; blobs: ReadonlyMap<string, Uint8Array> }> => {
    const groups: Array<{ refs: string[]; descendants: boolean }> = [
      {
        refs: from.contentNodeId ? [from.contentNodeId] : [],
        descendants: from.contentLoadChildNodes,
      },
      { refs: from.mediaIds, descendants: from.mediaLoadChildNodes },
      { refs: from.elementIds ?? [], descendants: false },
    ]

    const sets: ContentSet[] = []
    const blobKeys = new Set<string>()
    for (const group of groups) {
      if (group.refs.length === 0) continue
      const roots: NodeRow[] = []
      for (const ref of group.refs) {
        const resolved = await resolveNodeRef(db, CONTENT_OBJECT_TYPES, ref)
        // A pick that has since been deleted is dropped rather than failing the
        // download: the definition outlives the content it names.
        if (resolved.ok) roots.push(resolved.node)
      }
      if (roots.length === 0) continue
      const exported = await exportBundle(db, {
        roots,
        asGiven: group.refs,
        descendants: group.descendants,
        snapshot: 'published',
        blueprints: false,
        withBlobs: true,
        siteName: options.siteName,
        nodeId: options.nodeId,
      })
      sets.push(exported.set)
      for (const key of exported.blobKeys) blobKeys.add(key)
    }

    const merged = mergeContentSets(sets)
    if (!merged) return { set: undefined, blobs: new Map() }

    const { bytes } =
      blobKeys.size > 0
        ? await readBlobs(options.mediaStore, [...blobKeys])
        : { bytes: new Map<string, Uint8Array>() }
    return { set: merged, blobs: bytes }
  }

  return {
    marketplaceUrl: () => options.marketplaceUrl,

    async list(paging): Promise<Page<PackageDefinition>> {
      const result = await bundles.list(paging)
      return { total: result.total, items: result.items.map(definition) }
    },

    async byId(id) {
      const row = await bundles.byId(id)
      return row ? definition(row) : undefined
    },

    async create(input, id) {
      const invalid = validate(input)
      if (invalid) return invalid
      if (await bundles.byName(input.name)) return { ok: false, status: 'DuplicateName' }
      const row = await bundles.create(stored(input), id)
      return { ok: true, id: row.id }
    },

    async update(id, input) {
      const invalid = validate(input)
      if (invalid) return invalid
      if (!(await bundles.byId(id))) return { ok: false, status: 'NotFound' }
      const clash = await bundles.byName(input.name)
      if (clash && clash.id !== id) return { ok: false, status: 'DuplicateName' }
      await bundles.update(id, stored(input))
      return { ok: true, id }
    },

    async remove(id) {
      if (!(await bundles.byId(id))) return 'notFound'
      await bundles.delete(id)
      return 'deleted'
    },

    /**
     * The definition as one bundle, packed as the npm package it is.
     *
     * Everything goes through `writeBundle` so there is a single manifest over
     * the whole payload: it declares the sections, carries the hash that covers
     * them, and names the bundle. The package around it is what gives it a
     * name, a version and the core it was written for, so the download is
     * something `bun add ./file.tgz` and `bun publish` take as it is.
     */
    async build(id): Promise<BuiltPackage | undefined> {
      const row = await bundles.byId(id)
      if (!row) return undefined
      const from = definition(row)
      const pkg = bundlePackageOf(row)

      const sections = await siteSections(
        {
          db,
          componentFiles: options.componentFiles,
          components: options.components,
          stylesheets: options.stylesheets,
          scripts: options.scripts,
        },
        {
          contentTypes: from.contentTypes,
          mediaTypes: from.mediaTypes,
          dataTypes: from.dataTypes,
          languages: from.languages,
          components: [...from.templates, ...from.partialViews],
          stylesheets: from.stylesheets,
          scripts: from.scripts,
          dictionaryItems: from.dictionaryItems,
        },
      )

      const content = await contentEntries(from)
      // A package with nothing picked is still a bundle: an empty selection
      // produces an empty set rather than throwing, which is what gives a
      // schema-only package a manifest of its own.
      const set =
        content.set ??
        (
          await exportBundle(db, {
            roots: [],
            asGiven: [],
            descendants: false,
            snapshot: 'published',
            blueprints: false,
            withBlobs: false,
            siteName: options.siteName,
            nodeId: options.nodeId,
          })
        ).set

      const labelled: ContentSet = { ...set, manifest: { ...set.manifest, label: from.name } }
      const encoder = new TextEncoder()
      const files = writeBundlePackage(writeBundle(labelled, content.blobs, sections), {
        name: pkg.name,
        version: pkg.version,
        id: bundleIdFor(pkg.name.replace(/^@[^/]+\//, '')),
        label: from.name,
        peerRange: bundlePeerRange(VERSION),
      })
      const entries = files.map((file) => ({
        path: file.path,
        bytes: file.bytes ?? encoder.encode(file.text ?? ''),
      }))
      return {
        fileName: packageFileName(pkg.name, pkg.version),
        contentType: 'application/gzip',
        bytes: writeNpmTarball(entries),
      }
    },
  }
}

/** A created bundle's npm package as the Created view edits it. */
export interface CreatedBundlePackage {
  name: string
  version: string
  /** Whether each was set, rather than derived from the definition's name. */
  set: { name: boolean; version: boolean }
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The npm package a definition builds as, or undefined when it is gone. */
export async function readCreatedBundlePackage(
  db: Db,
  id: string,
): Promise<CreatedBundlePackage | undefined> {
  const row = await new BundleRepository(db).byId(id)
  if (!row) return undefined
  return {
    ...bundlePackageOf(row),
    set: { name: row.packageName !== null, version: row.packageVersion !== null },
  }
}

/**
 * Sets the npm package a definition builds as. An empty value goes back to its
 * default; anything else must be what npm itself would accept.
 */
export async function writeCreatedBundlePackage(
  db: Db,
  id: string,
  input: { name?: unknown; version?: unknown },
): Promise<{ ok: true; package: CreatedBundlePackage } | { ok: false; message: string }> {
  const bundles = new BundleRepository(db)
  if (!(await bundles.byId(id))) return { ok: false, message: 'That bundle no longer exists.' }
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const name = text(input.name)
  const version = text(input.version)
  if (name && !isPackageName(name))
    return {
      ok: false,
      message:
        'A package name is lowercase letters, digits, dots, hyphens and underscores, optionally with an @scope/ in front.',
    }
  if (version && !SEMVER.test(version))
    return { ok: false, message: 'A version is three numbers, like 1.0.0.' }
  await bundles.setPackage(id, { name: name || null, version: version || null })
  return { ok: true, package: (await readCreatedBundlePackage(db, id)) as CreatedBundlePackage }
}
