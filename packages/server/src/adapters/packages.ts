/**
 * Created packages: the definitions, and the zip a download builds from one.
 * `docs/17-packages.md`.
 *
 * Nothing new is serialized here. Schema travels as the canonical TOML
 * `@bunbraco/schema` already writes, content and media as the bundle
 * `@bunbraco/transfer` already exports, files as themselves, and dictionary
 * items as the `.udt` the dictionary already exports. The build is composition,
 * which is why a package can carry everything the builder UI offers.
 */
import { join } from 'node:path'
import {
  type BuiltPackage,
  type FileSystemPort,
  type PackageDefinition,
  type PackageDefinitionInput,
  type PackagePort,
  type PackageWriteResult,
  packageFileName,
} from '@bunbraco/api-management'
import { ObjectTypes, type Page } from '@bunbraco/core'
import {
  type CreatedPackage,
  CreatedPackageRepository,
  currentSchemaState,
  type Db,
  DictionaryRepository,
  type NodeRow,
  resolveNodeRef,
  type TemplateFileStore,
  TemplateRepository,
} from '@bunbraco/data'
import {
  exportSchemaSet,
  fileNameFor,
  type SchemaSet,
  writeDataType,
  writeDocumentType,
  writeLanguages,
  writeMediaType,
  writeSchemaVersion,
} from '@bunbraco/schema'
import {
  BUNDLE_SECTIONS,
  type BundleBlob,
  type BundleDependency,
  type BundleFile,
  type BundleKind,
  type BundleNode,
  type BundleSection,
  type ContentSet,
  exportBundle,
  writeBundle,
} from '@bunbraco/transfer'
import { dictionaryToUdt, writeDictionaryUdt } from '../dictionary-transfer.ts'
import { readBlobs } from '../media-files.ts'
import type { MediaStore } from '../media-store.ts'
import { writeZip, type ZipEntry } from '../zip.ts'

/** The content kinds a package's picks can name. */
const CONTENT_OBJECT_TYPES = [ObjectTypes.Document, ObjectTypes.Media, ObjectTypes.Element]

export interface PackagePortOptions {
  siteName: string
  nodeId: string
  marketplaceUrl: string
  /** Reads a template's view, which lives on disk rather than in the row. */
  templateFiles: TemplateFileStore
  mediaStore: MediaStore
  partialViews?: FileSystemPort
  stylesheets?: FileSystemPort
  scripts?: FileSystemPort
}

const definition = (row: CreatedPackage): PackageDefinition => ({
  id: row.id,
  name: row.name,
  contentNodeId: row.contentNodeId,
  contentLoadChildNodes: row.contentLoadChildNodes,
  mediaIds: row.mediaIds,
  mediaLoadChildNodes: row.mediaLoadChildNodes,
  elementIds: row.elementIds,
  documentTypes: row.documentTypes,
  mediaTypes: row.mediaTypes,
  dataTypes: row.dataTypes,
  templates: row.templates,
  partialViews: row.partialViews,
  stylesheets: row.stylesheets,
  scripts: row.scripts,
  languages: row.languages,
  dictionaryItems: row.dictionaryItems,
})

/** Matches a selection against a type's key or its alias, since the UI sends either. */
const picks = (selected: readonly string[]) => {
  const wanted = new Set(selected.map((value) => value.trim().toLowerCase()))
  return (type: { key?: string; alias: string }): boolean =>
    wanted.has(type.alias.toLowerCase()) ||
    (type.key !== undefined && wanted.has(type.key.toLowerCase()))
}

/** The selected slice of the site's schema, as the files `schema/` would hold. */
function schemaEntries(set: SchemaSet, from: PackageDefinition): BundleFile[] {
  const entries: BundleFile[] = []
  const put = (path: string, text: string) =>
    entries.push({ path: `${BUNDLE_SECTIONS.schema}/${path}`, text })

  const documentTypes = set.documentTypes.filter(picks(from.documentTypes))
  const mediaTypes = (set.mediaTypes ?? []).filter(picks(from.mediaTypes))
  // Member types have no picker in the builder, and the contract's definition
  // has no field for them, so a package never carries one.
  const dataTypes = set.dataTypes.filter(picks(from.dataTypes))
  const languages = set.languages.filter((language) =>
    from.languages.some((pick) => pick.toLowerCase() === language.iso.toLowerCase()),
  )

  if (
    documentTypes.length === 0 &&
    mediaTypes.length === 0 &&
    dataTypes.length === 0 &&
    languages.length === 0
  )
    return entries

  put('schema.toml', writeSchemaVersion(set.version))
  for (const type of documentTypes)
    put(join('document-types', fileNameFor(type.alias)), writeDocumentType(type))
  for (const type of mediaTypes)
    put(join('media-types', fileNameFor(type.alias)), writeMediaType(type))
  for (const type of dataTypes)
    put(join('data-types', fileNameFor(type.alias)), writeDataType(type))
  if (languages.length > 0) put('languages.toml', writeLanguages(languages))
  return entries
}

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
  const templates = new Set<string>()
  const languages = new Set<string>()
  const roots: string[] = []
  const asGiven: string[] = []
  for (const set of sets) {
    for (const dependency of set.manifest.dependencies.expected)
      expected.set(dependency.key, dependency)
    for (const key of set.manifest.dependencies.carried) carried.add(key)
    for (const type of set.manifest.dependencies.schema.contentTypes)
      contentTypes.set(type.key, type)
    for (const alias of set.manifest.dependencies.schema.templates) templates.add(alias)
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
          templates: [...templates],
          languages: [...languages],
        },
      },
      blobs: [...blobs.values()],
    },
  }
}

export function createPackagePort(db: Db, options: PackagePortOptions): PackagePort {
  const packages = new CreatedPackageRepository(db)

  const validate = (input: PackageDefinitionInput): PackageWriteResult | undefined =>
    input.name.length === 0 ? { ok: false, status: 'InvalidName' } : undefined

  /**
   * The files a selection of file-system paths resolves to, under one section.
   *
   * The section is a logical name — `styles`, not `css` — because a site holds
   * these wherever it is configured to, and the importer is what maps a section
   * onto a directory.
   */
  const fileEntries = async (
    port: FileSystemPort | undefined,
    paths: readonly string[],
    section: BundleSection,
  ): Promise<BundleFile[]> => {
    if (!port) return []
    const files: BundleFile[] = []
    for (const path of paths) {
      const file = await port.read(path)
      if (!file) continue
      const relative = file.path.replace(/^\/+/, '')
      files.push({ path: `${BUNDLE_SECTIONS[section]}/${relative}`, text: file.content })
    }
    return files
  }

  const templateEntries = async (keys: readonly string[]): Promise<BundleFile[]> => {
    if (keys.length === 0) return []
    const templates = new TemplateRepository(db, options.templateFiles)
    const all = await templates.all()
    const wanted = new Set(keys.map((key) => key.trim().toLowerCase()))
    const files: BundleFile[] = []
    for (const template of all) {
      if (!wanted.has(template.key.toLowerCase()) && !wanted.has(template.alias.toLowerCase()))
        continue
      files.push({
        path: `${BUNDLE_SECTIONS.views}/${template.alias}.tsx`,
        text: template.content ?? '',
      })
    }
    return files
  }

  const dictionaryEntries = async (keys: readonly string[]): Promise<BundleFile[]> => {
    if (keys.length === 0) return []
    const repo = new DictionaryRepository(db)
    const items = []
    for (const key of keys) items.push(...(await dictionaryToUdt(repo, key)))
    if (items.length === 0) return []
    return [{ path: `${BUNDLE_SECTIONS.dictionary}.udt`, text: writeDictionaryUdt(items) }]
  }

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
      const result = await packages.list(paging)
      return { total: result.total, items: result.items.map(definition) }
    },

    async byId(id) {
      const row = await packages.byId(id)
      return row ? definition(row) : undefined
    },

    async create(input, id) {
      const invalid = validate(input)
      if (invalid) return invalid
      if (await packages.byName(input.name)) return { ok: false, status: 'DuplicateName' }
      const row = await packages.create(input, id)
      return { ok: true, id: row.id }
    },

    async update(id, input) {
      const invalid = validate(input)
      if (invalid) return invalid
      if (!(await packages.byId(id))) return { ok: false, status: 'NotFound' }
      const clash = await packages.byName(input.name)
      if (clash && clash.id !== id) return { ok: false, status: 'DuplicateName' }
      await packages.update(id, input)
      return { ok: true, id }
    },

    async remove(id) {
      if (!(await packages.byId(id))) return 'notFound'
      await packages.delete(id)
      return 'deleted'
    },

    /**
     * The definition as one bundle, zipped.
     *
     * Everything goes through `writeBundle` so there is a single manifest over
     * the whole artifact: it declares the sections, carries the hash that covers
     * them, and names the package — a zip of loose directories would have no
     * record of what it was or whether it arrived whole.
     */
    async build(id): Promise<BuiltPackage | undefined> {
      const row = await packages.byId(id)
      if (!row) return undefined
      const from = definition(row)

      // The schema version the site is actually at, so the files a package
      // carries say where they came from rather than claiming version 0.
      const state = await currentSchemaState(db).catch(() => undefined)
      const schema = await exportSchemaSet(db, state?.version ?? '0')

      const sections: BundleFile[] = [
        ...schemaEntries(schema, from),
        ...(await templateEntries(from.templates)),
        ...(await fileEntries(options.partialViews, from.partialViews, 'partials')),
        ...(await fileEntries(options.stylesheets, from.stylesheets, 'styles')),
        ...(await fileEntries(options.scripts, from.scripts, 'scripts')),
        ...(await dictionaryEntries(from.dictionaryItems)),
      ]

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
      const entries: ZipEntry[] = writeBundle(labelled, content.blobs, sections).map((file) => ({
        path: file.path,
        bytes: file.bytes ?? encoder.encode(file.text ?? ''),
      }))
      return { fileName: packageFileName(from.name), bytes: writeZip(entries) }
    },
  }
}
