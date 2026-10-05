/**
 * Importing an Umbraco site: a compatibility report, and then the files of a
 * bunbraco site. `docs/16-umbraco-import.md`.
 *
 * Nothing here writes a database row or a file. The result is a report and a
 * list of files — schema, a content bundle, view stubs — for the caller to put
 * on disk, so the import itself is `bunbraco start --bundle`, through the code
 * that every other bundle goes through.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  fileNameFor,
  writeDataType,
  writeDocumentType,
  writeLanguages,
  writeMediaType,
  writeMemberType,
  writeSchemaVersion,
} from '@bunbraco/schema'
import { writeBundle } from '@bunbraco/transfer'
import { convertContent } from './content.ts'
import { Findings } from './findings.ts'
import { type DictionaryItem, type DomainEntry, takeInventory } from './inventory.ts'
import { buildReport, type ImportReport, reportJson, reportMarkdown } from './report.ts'
import { convertSchema } from './schema.ts'
import { readSiteFiles, type SiteFiles } from './site-files.ts'
import { openSource } from './source.ts'
import { detectVersion, MINIMUM_MAJOR, NEWEST_MAJOR } from './version.ts'
import { componentPathFor, componentStub, viewStub } from './views.ts'

export { CLASS_ORDER, CLASS_TITLES, type Finding, type FindingClass } from './findings.ts'
export { type DictionaryItem, type DomainEntry, sourceUrls } from './inventory.ts'
export {
  type ImportReport,
  reportJson,
  reportMarkdown,
  reportSummary,
} from './report.ts'
export { SUPPORTED_EDITORS } from './schema.ts'
export { openSource, type Source } from './source.ts'
export {
  type DetectedVersion,
  detectVersion,
  MINIMUM_MAJOR,
  NEWEST_MAJOR,
  UPGRADE_STATES,
  versionForState,
} from './version.ts'
export { componentName, componentPathFor, componentStub, viewStub } from './views.ts'

/** Where the bundle goes in the new site, and what the start script names. */
export const IMPORT_BUNDLE = 'bundles/umbraco-import'
/** Where the report and everything a person has to act on are kept. */
export const IMPORT_DIR = 'import'

export interface ImportOptions {
  /** The database backup: a `.bacpac`, or Umbraco's own SQLite file. */
  source: string
  /** The site's files — the web root or anything above it — when the backup has them. */
  site?: string
  /** Where media files are, when not under the site's `wwwroot/media`. */
  media?: string
  siteName?: string
  /** Take each page's working copy rather than what is published. */
  drafts?: boolean
  /** Keep the staging database here instead of in a temporary directory. */
  staging?: string
}

/** One file of the new site: literal text, or a file to copy. */
export interface SiteFile {
  /** Relative to the new site, `/`-separated. */
  path: string
  text?: string
  bytes?: Uint8Array
  copyFrom?: string
}

export interface ImportPlan {
  report: ImportReport
  siteName: string
  /** Empty when the report has a blocking finding. */
  files: SiteFile[]
  dictionary: DictionaryItem[]
  domains: DomainEntry[]
  /** Media nodes whose file was not found; the import must be told to allow them. */
  missingMedia: number
  /** The paths the source site served, to check the imported site against. */
  urls: string[]
}

export async function planImport(options: ImportOptions): Promise<ImportPlan> {
  const source = await openSource(options.source, { staging: options.staging })
  try {
    const findings = new Findings()
    const files: SiteFiles | undefined = options.site
      ? readSiteFiles(options.site, options.media)
      : options.media
        ? {
            root: '',
            razor: [],
            mediaDir: options.media,
            packages: [],
            plugins: [],
            csharp: 0,
            assets: [],
          }
        : undefined
    const describe = () =>
      buildReport(
        {
          path: options.source,
          kind: source.kind,
          exportedAt: source.exportedAt,
          serverVersion: source.serverVersion,
          siteFiles: options.site !== undefined,
        },
        umbraco,
        findings.list,
      )
    const stopped = (): ImportPlan => ({
      report: describe(),
      siteName: options.siteName ?? 'Imported site',
      files: [],
      dictionary: [],
      domains: [],
      missingMedia: 0,
      urls: [],
    })

    const umbraco = detectVersion(source)
    if (umbraco.status === 'unknown') {
      findings.add({
        class: 'blocking',
        code: 'not-umbraco',
        title: 'This is not an Umbraco database the importer recognises',
        detail: `It has no upgrade state for Umbraco 10 or later. The importer reads Umbraco ${MINIMUM_MAJOR} to ${NEWEST_MAJOR}; an older site has to be upgraded with Umbraco first.`,
      })
      return stopped()
    }
    if (umbraco.status === 'too-old') {
      findings.add({
        class: 'blocking',
        code: 'version-too-old',
        title: `Umbraco ${umbraco.version} is older than the importer supports`,
        detail: `Upgrade the site to Umbraco ${MINIMUM_MAJOR} or later with Umbraco itself, export it again, then import. Umbraco’s own upgrader rewrites the stored content formats that changed in 14 and 15, and is the one tool certain to do it correctly.`,
      })
      return stopped()
    }
    if (umbraco.status === 'newer')
      findings.add({
        class: 'needs-a-person',
        code: 'version-newer',
        title: 'This Umbraco version is newer than the importer has been written against',
        detail: `The importer knows Umbraco up to ${NEWEST_MAJOR}. It will try, but check the result carefully.`,
      })

    const schema = convertSchema(source, findings)
    const siteName =
      options.siteName ??
      source.one<{ name: string | null }>(
        `SELECT n."text" AS name FROM umbracoNode n
         WHERE n.nodeObjectType = 'c66ba18e-eaf3-4cff-8a22-41b16d66a972' COLLATE NOCASE
           AND n.parentId = -1 AND n.trashed = 0 ORDER BY n.sortOrder LIMIT 1`,
      )?.name ??
      'Imported site'
    const content = convertContent(source, schema, findings, {
      snapshot: options.drafts ? 'drafts' : 'published',
      siteName,
    })
    const inventory = takeInventory(source, schema, files, findings)

    const out: SiteFile[] = []

    // Schema
    out.push({ path: 'schema/schema.toml', text: writeSchemaVersion(schema.set.version) })
    for (const type of schema.set.documentTypes)
      out.push({
        path: `schema/document-types/${fileNameFor(type.alias)}`,
        text: writeDocumentType(type),
      })
    for (const type of schema.set.mediaTypes ?? [])
      out.push({
        path: `schema/media-types/${fileNameFor(type.alias)}`,
        text: writeMediaType(type),
      })
    for (const type of schema.set.memberTypes ?? [])
      out.push({
        path: `schema/member-types/${fileNameFor(type.alias)}`,
        text: writeMemberType(type),
      })
    for (const dataType of schema.set.dataTypes)
      out.push({
        path: `schema/data-types/${fileNameFor(dataType.alias)}`,
        text: writeDataType(dataType),
      })
    if (schema.set.languages.length > 0)
      out.push({ path: 'schema/languages.toml', text: writeLanguages(schema.set.languages) })

    // Views: a stub per template, and the Razor it stands in for.
    const templates = [...schema.templates.values()]
    const layouts = new Set(templates.flatMap((template) => template.layout ?? []))
    const razorByAlias = new Map(
      (files?.razor ?? [])
        .filter((file) => /^Views\/[^/]+\.cshtml$/i.test(file.path))
        .map((file) => [file.path.slice(6, -7).toLowerCase(), file]),
    )
    for (const template of templates) {
      const original = razorByAlias.get(template.alias.toLowerCase())
      out.push({
        path: `components/${template.alias}.tsx`,
        text: viewStub(template, {
          isLayout: layouts.has(template.alias),
          original: original ? `${IMPORT_DIR}/razor/${original.path}` : undefined,
        }),
      })
    }
    for (const razor of files?.razor ?? [])
      out.push({ path: `${IMPORT_DIR}/razor/${razor.path}`, copyFrom: razor.file })
    findings.some({
      class: 'needs-a-person',
      code: 'razor-templates',
      title: 'Razor templates to rewrite as TSX',
      detail:
        'Each has a stub in components/ that renders the page’s name inside the same layout chain, so the site boots and every page answers. The markup itself has to be rewritten.',
      count: templates.length,
      items: templates.map((template) => {
        const original = razorByAlias.get(template.alias.toLowerCase())
        if (!original) return template.alias
        const uses = original.uses.length > 0 ? `, uses ${original.uses.join(', ')}` : ''
        return `${template.alias} (${original.lines} lines${uses})`
      }),
    })
    // Every other Razor view — partials, shared layouts, anything nested — is a
    // component too. There is one root and one kind of file, so each gets a
    // stub where it sat, rather than being left as reference material with
    // nothing on disk for a template to import.
    const others = (files?.razor ?? []).filter((file) => !/^Views\/[^/]+\.cshtml$/i.test(file.path))
    for (const file of others)
      out.push({
        path: componentPathFor(file.path),
        text: componentStub(file.path, `${IMPORT_DIR}/razor/${file.path}`),
      })
    findings.some({
      class: 'needs-a-person',
      code: 'razor-partials',
      title: 'Razor views to rewrite as components',
      detail:
        `Each has a stub under components/, in the folder it sat in, so an import of it ` +
        `resolves. The original is in ${IMPORT_DIR}/razor/ and the markup has to be rewritten.`,
      count: others.length,
      items: others.map((file) => `${file.path} (${file.lines} lines)`),
    })

    // Media files go straight into the site's media directory, under the keys
    // the values name, so nothing has to hold a whole media library in memory.
    const missing: string[] = []
    const seen = new Set<string>()
    for (const blob of content.blobs) {
      if (seen.has(blob.key)) continue
      seen.add(blob.key)
      const file = files?.mediaDir ? join(files.mediaDir, blob.key) : undefined
      if (file && existsSync(file)) out.push({ path: `media/${blob.key}`, copyFrom: file })
      else missing.push(blob.key)
    }
    findings.some({
      class: 'migrates',
      code: 'media-files',
      title: 'Media files',
      count: seen.size - missing.length,
    })
    findings.some({
      class: 'needs-a-person',
      code: 'media-files-missing',
      title: 'Media items with no file',
      detail: files?.mediaDir
        ? `Not found under ${files.mediaDir}. The media items are imported and will show as broken until their files are put in media/.`
        : 'No media directory was given (--site or --media). The media items are imported and will show as broken until their files are put in media/.',
      count: missing.length,
      items: missing,
    })

    for (const asset of files?.assets ?? []) {
      const [folder, ...rest] = asset.path.split('/')
      out.push({
        path: `${folder === 'css' ? 'css' : 'scripts'}/${rest.join('/')}`,
        copyFrom: asset.file,
      })
    }
    findings.some({
      class: 'migrates',
      code: 'assets',
      title: 'Stylesheets and scripts',
      count: files?.assets.length ?? 0,
    })

    // The bundle, in the format `content import` already reads.
    for (const file of writeBundle(content.set))
      out.push({ path: `${IMPORT_BUNDLE}/${file.path}`, text: file.text, bytes: file.bytes })

    if (inventory.urls.length > 0)
      out.push({ path: `${IMPORT_DIR}/urls.txt`, text: `${inventory.urls.join('\n')}\n` })
    findings.some({
      class: 'migrates',
      code: 'urls',
      title: 'Published URLs',
      detail: `Listed in ${IMPORT_DIR}/urls.txt, to check the imported site against.`,
      count: inventory.urls.length,
    })

    const report = describe()
    out.push({ path: `${IMPORT_DIR}/report.md`, text: reportMarkdown(report) })
    out.push({ path: `${IMPORT_DIR}/report.json`, text: reportJson(report) })

    return {
      report,
      siteName,
      files: report.ready ? out : [],
      dictionary: inventory.dictionary,
      domains: inventory.domains,
      missingMedia: missing.length,
      urls: inventory.urls,
    }
  } finally {
    source.close()
  }
}
