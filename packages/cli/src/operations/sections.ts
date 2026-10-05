/**
 * The sections a bundle carries beyond its content: schema, views, partials,
 * styles, scripts and dictionary items. `docs/17-packages.md`.
 *
 * A bundle names what a file *is*, never where it goes — the destination site
 * decides that from its own configuration, so a bundle written against one
 * layout installs into another. This module owns that mapping, and the order
 * applying them has to happen in: structure before the content that needs it,
 * views before the content that names a template.
 *
 * Checking is read-only and has to answer "what would the schema do" *before*
 * anything is written, which `checkSchemaDirectory` cannot do against files that
 * are not there yet. So the check runs against a copy of the site's `schema/`
 * with the bundle's files laid over it — the site's own directory is never
 * touched until an apply.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Db } from '@bunbraco/data'
import type { BunbracoConfig } from '@bunbraco/server'
import { checkSchemaDirectory, importDictionaryUdt, syncSchemaDirectory } from '@bunbraco/server'
import type { BundleSection, LoadedBundle } from '@bunbraco/transfer'
import { BUNDLE_SECTIONS } from '@bunbraco/transfer'

/** What applying one carried file would do to the destination. */
export type FileAction = 'create' | 'overwrite' | 'unchanged'

export interface SectionFile {
  /** The path inside the bundle, e.g. `views/homePage.tsx`. */
  path: string
  /** Where it would land on this site. */
  target: string
  action: FileAction
}

export interface SectionPlan {
  files: SectionFile[]
  /** How many dictionary items the bundle carries, when it carries any. */
  dictionaryItems: number
  /**
   * What the schema half would do, checked against an overlay rather than the
   * site: `none` when the bundle carries no schema.
   */
  schema: { classification: string; findings: string[] } | undefined
  /** Sections present in the bundle, for a caller that only wants to say so. */
  sections: BundleSection[]
}

export interface SectionOptions {
  /** Skip the schema half, leaving the site's own structure alone. */
  withoutSchema?: boolean
  /** Skip views, partials, styles and scripts. */
  withoutFiles?: boolean
}

/** Where each section lands, from the site's own configuration. */
function destinationOf(config: BunbracoConfig, section: BundleSection): string | undefined {
  switch (section) {
    case 'schema':
      return config.schemaDir
    case 'views':
      return config.viewsDir
    // Umbraco's place, and ours: `Views/Partials`.
    case 'partials':
      return join(config.viewsDir, 'Partials')
    case 'styles':
      return config.stylesheetsDir
    case 'scripts':
      return config.scriptsDir
    case 'dictionary':
      return undefined
  }
}

const FILE_SECTIONS: readonly BundleSection[] = ['views', 'partials', 'styles', 'scripts']

/** The path inside a section, with the section's own directory stripped. */
const withinSection = (path: string, section: BundleSection): string =>
  path.slice(`${BUNDLE_SECTIONS[section]}/`.length)

function actionFor(target: string, content: string): FileAction {
  if (!existsSync(target)) return 'create'
  try {
    return readFileSync(target, 'utf8') === content ? 'unchanged' : 'overwrite'
  } catch {
    return 'overwrite'
  }
}

export interface CarriedSections {
  /** Section → the bundle paths it carries. */
  carries: Partial<Record<BundleSection, string[]>>
  /** Bundle path → the file on disk holding it. */
  files: Map<string, string>
}

/** What a loaded bundle carries, or nothing when it is content-only. */
export function carriedSections(loaded: LoadedBundle): CarriedSections {
  return { carries: loaded.set?.manifest.carries ?? {}, files: loaded.files }
}

const read = (carried: CarriedSections, path: string): string => {
  const file = carried.files.get(path)
  if (!file) throw new Error(`${path} is declared but was not read`)
  return readFileSync(file, 'utf8')
}

/** Read-only: what applying the carried sections here would do. */
export async function planSections(
  db: Db,
  config: BunbracoConfig,
  carried: CarriedSections,
  options: SectionOptions = {},
): Promise<SectionPlan> {
  const sections = Object.keys(carried.carries) as BundleSection[]
  const files: SectionFile[] = []

  if (!options.withoutFiles) {
    for (const section of FILE_SECTIONS) {
      const destination = destinationOf(config, section)
      if (!destination) continue
      for (const path of carried.carries[section] ?? []) {
        const target = join(destination, withinSection(path, section))
        files.push({ path, target, action: actionFor(target, read(carried, path)) })
      }
    }
  }

  const schemaPaths = options.withoutSchema ? [] : (carried.carries.schema ?? [])
  if (!options.withoutSchema) {
    for (const path of schemaPaths) {
      const target = join(config.schemaDir, withinSection(path, 'schema'))
      files.push({ path, target, action: actionFor(target, read(carried, path)) })
    }
  }

  return {
    files,
    dictionaryItems: (carried.carries.dictionary ?? []).length,
    schema:
      schemaPaths.length > 0
        ? await checkSchemaOverlay(db, config, carried, schemaPaths)
        : undefined,
    sections,
  }
}

/**
 * The schema check, run against a copy of the site's `schema/` with the
 * bundle's files laid over it.
 *
 * The site's directory is not written to: a check has to be able to say "this
 * would need data work" without having already changed the thing it is
 * reporting on.
 */
async function checkSchemaOverlay(
  db: Db,
  config: BunbracoConfig,
  carried: CarriedSections,
  paths: readonly string[],
): Promise<{ classification: string; findings: string[] }> {
  const overlay = mkdtempSync(join(tmpdir(), 'bunbraco-schema-overlay-'))
  try {
    if (existsSync(config.schemaDir)) cpSync(config.schemaDir, overlay, { recursive: true })
    for (const path of paths) {
      const target = join(overlay, withinSection(path, 'schema'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, read(carried, path))
    }
    const report = await checkSchemaDirectory(
      db,
      { ...config, schemaDir: overlay },
      { nodeId: config.nodeId, revision: config.schemaRevision },
    )
    return {
      classification: report.classification,
      findings: report.outstanding.map((finding) => finding.message),
    }
  } finally {
    rmSync(overlay, { recursive: true, force: true })
  }
}

export interface SectionResult {
  /** The files written, by the path they were written to. */
  written: string[]
  /** The schema sync's outcome, when the bundle carried schema. */
  schema: { action: string } | undefined
  dictionary: { imported: number; skipped: string[] } | undefined
}

/**
 * Applies the carried sections, structure first.
 *
 * Schema goes to `schema/` and is then synced — the same path a commit takes,
 * so an install cannot produce a database the files do not describe. Views land
 * before content is imported, because a node naming a template whose view is
 * absent arrives without one.
 */
export async function applySections(
  db: Db,
  config: BunbracoConfig,
  carried: CarriedSections,
  options: SectionOptions = {},
): Promise<SectionResult> {
  const written: string[] = []
  const put = (target: string, content: string) => {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    written.push(target)
  }

  const schemaPaths = options.withoutSchema ? [] : (carried.carries.schema ?? [])
  for (const path of schemaPaths)
    put(join(config.schemaDir, withinSection(path, 'schema')), read(carried, path))

  let schema: { action: string } | undefined
  if (schemaPaths.length > 0) {
    const report = await syncSchemaDirectory(db, config, {
      nodeId: config.nodeId,
      revision: config.schemaRevision,
    })
    schema = { action: report.action }
  }

  if (!options.withoutFiles) {
    for (const section of FILE_SECTIONS) {
      const destination = destinationOf(config, section)
      if (!destination) continue
      for (const path of carried.carries[section] ?? [])
        put(join(destination, withinSection(path, section)), read(carried, path))
    }
  }

  let dictionary: SectionResult['dictionary']
  for (const path of carried.carries.dictionary ?? []) {
    const outcome = await importDictionaryUdt(db, read(carried, path))
    dictionary = {
      imported: (dictionary?.imported ?? 0) + outcome.imported,
      skipped: [...(dictionary?.skipped ?? []), ...outcome.skipped],
    }
  }

  return { written, schema, dictionary }
}

/** Whether a bundle carries anything beyond its content. */
export const carriesSections = (carried: CarriedSections): boolean =>
  Object.keys(carried.carries).length > 0
