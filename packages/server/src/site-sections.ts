/**
 * The sections a bundle carries beyond its content — schema, components,
 * styles, scripts and the dictionary — gathered from a site. One place, so the
 * backoffice's Packages builder (picked items) and `crombolo export --site`
 * (everything) compose a bundle the same way. `docs/bundles.md`.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { FileSystemPort } from '@crombolo/api-management'
import {
  type ComponentFileStore,
  ComponentRepository,
  currentSchemaState,
  type Db,
  DictionaryRepository,
} from '@crombolo/data'
import {
  exportSchemaSet,
  fileNameFor,
  type SchemaSet,
  writeContentType,
  writeDataType,
  writeLanguages,
  writeMediaType,
  writeSchemaVersion,
} from '@crombolo/schema'
import { BUNDLE_SECTIONS, type BundleFile, type BundleSection } from '@crombolo/transfer'
import { dictionaryToUdt, writeDictionaryUdt } from './dictionary-transfer.ts'

export interface SiteSectionSources {
  db: Db
  /** Reads a template's view, which lives on disk rather than in the row. */
  componentFiles: ComponentFileStore
  components?: FileSystemPort
  stylesheets?: FileSystemPort
  scripts?: FileSystemPort
  /** The schema directory, read whole for `'all'`: the files are the schema. */
  schemaDir?: string
}

/** What a Packages definition picks, by key or alias as the backoffice sends them. */
export interface SectionPicks {
  contentTypes: readonly string[]
  mediaTypes: readonly string[]
  dataTypes: readonly string[]
  languages: readonly string[]
  /** Template aliases and paths in the components tree, in one list. */
  components: readonly string[]
  stylesheets: readonly string[]
  scripts: readonly string[]
  dictionaryItems: readonly string[]
}

/** Matches a selection against a type's key or its alias, since the UI sends either. */
const picks = (selected: readonly string[]) => {
  const wanted = new Set(selected.map((value) => value.trim().toLowerCase()))
  return (type: { key?: string; alias: string }): boolean =>
    wanted.has(type.alias.toLowerCase()) ||
    (type.key !== undefined && wanted.has(type.key.toLowerCase()))
}

/** The selected slice of the site's schema, as the files `schema/` would hold. */
function schemaEntries(set: SchemaSet, from: SectionPicks): BundleFile[] {
  const entries: BundleFile[] = []
  const put = (path: string, text: string) =>
    entries.push({ path: `${BUNDLE_SECTIONS.schema}/${path}`, text })

  const contentTypes = set.contentTypes.filter(picks(from.contentTypes))
  const mediaTypes = (set.mediaTypes ?? []).filter(picks(from.mediaTypes))
  // Member types have no picker in the builder, and the contract's definition
  // has no field for them, so a picked bundle never carries one.
  const dataTypes = set.dataTypes.filter(picks(from.dataTypes))
  const languages = set.languages.filter((language) =>
    from.languages.some((pick) => pick.toLowerCase() === language.iso.toLowerCase()),
  )

  if (
    contentTypes.length === 0 &&
    mediaTypes.length === 0 &&
    dataTypes.length === 0 &&
    languages.length === 0
  )
    return entries

  put('schema.toml', writeSchemaVersion(set.version))
  for (const type of contentTypes)
    put(join('content-types', fileNameFor(type.alias)), writeContentType(type))
  for (const type of mediaTypes)
    put(join('media-types', fileNameFor(type.alias)), writeMediaType(type))
  for (const type of dataTypes)
    put(join('data-types', fileNameFor(type.alias)), writeDataType(type))
  if (languages.length > 0) put('languages.toml', writeLanguages(languages))
  return entries
}

/** Every `.toml` under the schema directory, as it stands: the whole site's schema. */
async function wholeSchema(dir: string | undefined): Promise<BundleFile[]> {
  if (!dir) return []
  const files: BundleFile[] = []
  const walk = async (at: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.toLowerCase().endsWith('.toml'))
        files.push({
          path: `${BUNDLE_SECTIONS.schema}/${relative(dir, path).split(sep).join('/')}`,
          text: await readFile(path, 'utf8'),
        })
    }
  }
  await walk(dir)
  return files
}

/** Every file a file area holds, by its path within the area. */
async function everyPath(port: FileSystemPort | undefined): Promise<string[]> {
  if (!port) return []
  const paths: string[] = []
  const walk = async (parent: string | null): Promise<void> => {
    for (const entry of (await port.children(parent)) ?? []) {
      if (entry.isFolder) await walk(entry.path)
      else paths.push(entry.path)
    }
  }
  await walk(null)
  return paths
}

/**
 * The files a selection of file-system paths resolves to, under one section.
 *
 * The section is a logical name — `styles`, not `css` — because a site holds
 * these wherever it is configured to, and the importer is what maps a section
 * onto a directory.
 */
async function fileEntries(
  port: FileSystemPort | undefined,
  paths: readonly string[],
  section: BundleSection,
): Promise<BundleFile[]> {
  if (!port) return []
  const files: BundleFile[] = []
  for (const path of paths) {
    const file = await port.read(path)
    if (!file) continue
    const within = file.path.replace(/^\/+/, '')
    files.push({ path: `${BUNDLE_SECTIONS[section]}/${within}`, text: file.content })
  }
  return files
}

async function componentEntries(
  sources: SiteSectionSources,
  keys: readonly string[],
): Promise<BundleFile[]> {
  if (keys.length === 0) return []
  const templates = new ComponentRepository(sources.db, sources.componentFiles)
  const wanted = new Set(keys.map((key) => key.trim().toLowerCase()))
  const files: BundleFile[] = []
  for (const template of await templates.all()) {
    if (!wanted.has(template.key.toLowerCase()) && !wanted.has(template.alias.toLowerCase()))
      continue
    files.push({
      path: `${BUNDLE_SECTIONS.components}/${template.alias}.tsx`,
      text: template.content ?? '',
    })
  }
  return files
}

/**
 * The components a bundle carries, from one list that holds two kinds of name.
 *
 * The contract has `templates` and `partialViews`; this side has one list, so a
 * picked component arrives either as a template alias — read through the alias
 * — or as a path in the components tree. Both are tried and the results are
 * keyed by path, so a component picked both ways is carried once.
 */
async function componentSection(
  sources: SiteSectionSources,
  picked: readonly string[],
): Promise<BundleFile[]> {
  const byPath = new Map<string, BundleFile>()
  for (const file of await componentEntries(sources, picked)) byPath.set(file.path, file)
  for (const file of await fileEntries(sources.components, picked, 'components'))
    byPath.set(file.path, file)
  return [...byPath.values()]
}

/** The dictionary as one `.udt`: the picked items, or every root item when none are named. */
async function dictionaryEntries(db: Db, keys: readonly string[] | 'all'): Promise<BundleFile[]> {
  const repo = new DictionaryRepository(db)
  const items =
    keys === 'all'
      ? await dictionaryToUdt(repo)
      : (await Promise.all(keys.map((key) => dictionaryToUdt(repo, key)))).flat()
  if (items.length === 0) return []
  return [{ path: `${BUNDLE_SECTIONS.dictionary}.udt`, text: writeDictionaryUdt(items) }]
}

/** The picked sections, or with `'all'` every one of them in full. */
export async function siteSections(
  sources: SiteSectionSources,
  selection: SectionPicks | 'all',
): Promise<BundleFile[]> {
  if (selection === 'all') {
    return [
      ...(await wholeSchema(sources.schemaDir)),
      ...(await fileEntries(sources.components, await everyPath(sources.components), 'components')),
      ...(await fileEntries(sources.stylesheets, await everyPath(sources.stylesheets), 'styles')),
      ...(await fileEntries(sources.scripts, await everyPath(sources.scripts), 'scripts')),
      ...(await dictionaryEntries(sources.db, 'all')),
    ]
  }
  // The schema version the site is actually at, so the files a package carries
  // say where they came from rather than claiming version 0.
  const state = await currentSchemaState(sources.db).catch(() => undefined)
  const schema = await exportSchemaSet(sources.db, state?.version ?? '0')
  return [
    ...schemaEntries(schema, selection),
    ...(await componentSection(sources, selection.components)),
    ...(await fileEntries(sources.stylesheets, selection.stylesheets, 'styles')),
    ...(await fileEntries(sources.scripts, selection.scripts, 'scripts')),
    ...(selection.dictionaryItems.length > 0
      ? await dictionaryEntries(sources.db, selection.dictionaryItems)
      : []),
  ]
}
