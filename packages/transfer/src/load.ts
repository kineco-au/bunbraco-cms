/**
 * A bundle on disk → `ContentSet`, validated.
 *
 * Reading is strict about shape and about integrity, and says which file was
 * wrong, because everything downstream assumes a bundle is well formed: the
 * check reports on what it would do, and by then a malformed node file would be
 * a crash rather than a finding.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_SECTIONS,
  type BundleKind,
  type BundleManifest,
  type BundleNode,
  type BundleProblem,
  type BundleSection,
  type BundleValue,
  type BundleVariant,
  type ContentSet,
} from './model.ts'
import { blobPath, bundleIntegrity, MANIFEST_FILE, nodePath, sectionOf } from './write.ts'

export interface LoadedBundle {
  set: ContentSet | undefined
  problems: BundleProblem[]
  /**
   * The carried section files, by their path inside the bundle, as paths on
   * disk — the structure and views an install applies. Empty for a
   * content-only bundle, which is every version 1 bundle.
   */
  files: Map<string, string>
  /**
   * The media files the bundle carries, by store key, as paths on disk.
   *
   * Paths rather than bytes: a bundle of a media library is as large as the
   * library, and nothing here needs it in memory at once.
   */
  blobs: Map<string, string>
}

const KINDS: readonly BundleKind[] = ['document', 'media', 'element', 'blueprint']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const nullableStr = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? v : undefined

function parseVariant(
  raw: unknown,
  file: string,
  problems: BundleProblem[],
): BundleVariant | undefined {
  if (!isRecord(raw)) {
    problems.push({ file, message: 'a variant is not an object' })
    return undefined
  }
  const name = str(raw.name)
  const culture = nullableStr(raw.culture)
  const segment = nullableStr(raw.segment)
  if (name === undefined || culture === undefined || segment === undefined) {
    problems.push({ file, message: 'a variant needs culture, segment and name' })
    return undefined
  }
  return { culture, segment, name, published: raw.published === true }
}

function parseValue(
  raw: unknown,
  file: string,
  problems: BundleProblem[],
): BundleValue | undefined {
  if (!isRecord(raw)) {
    problems.push({ file, message: 'a value is not an object' })
    return undefined
  }
  const property = str(raw.property)
  const editor = str(raw.editor)
  const culture = nullableStr(raw.culture)
  const segment = nullableStr(raw.segment)
  if (
    property === undefined ||
    editor === undefined ||
    culture === undefined ||
    segment === undefined
  ) {
    problems.push({ file, message: 'a value needs property, editor, culture and segment' })
    return undefined
  }
  const references = Array.isArray(raw.references)
    ? raw.references.flatMap((r) => (typeof r === 'string' ? [r] : []))
    : undefined
  return { property, culture, segment, editor, value: raw.value, references }
}

export function parseNode(
  text: string,
  file: string,
  problems: BundleProblem[],
): BundleNode | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    problems.push({ file, message: `not JSON: ${(error as Error).message}` })
    return undefined
  }
  if (!isRecord(raw)) {
    problems.push({ file, message: 'not an object' })
    return undefined
  }
  const key = str(raw.key)
  const kind = str(raw.kind) as BundleKind | undefined
  const contentType = isRecord(raw.contentType) ? raw.contentType : undefined
  const typeKey = str(contentType?.key)
  const typeAlias = str(contentType?.alias)
  if (!key) problems.push({ file, message: 'no key' })
  if (!kind || !KINDS.includes(kind))
    problems.push({ file, message: `kind must be one of ${KINDS.join(', ')}` })
  if (!typeAlias) problems.push({ file, message: 'no contentType.alias' })
  const parent = nullableStr(raw.parent)
  if (parent === undefined) problems.push({ file, message: 'parent must be a key or null' })
  if (!key || !kind || !KINDS.includes(kind) || !typeAlias || parent === undefined) return undefined

  const variants = Array.isArray(raw.variants)
    ? raw.variants.flatMap((v) => {
        const parsed = parseVariant(v, file, problems)
        return parsed ? [parsed] : []
      })
    : []
  const values = Array.isArray(raw.values)
    ? raw.values.flatMap((v) => {
        const parsed = parseValue(v, file, problems)
        return parsed ? [parsed] : []
      })
    : []
  if (variants.length === 0) problems.push({ file, message: 'no variants: a node needs a name' })

  return {
    key,
    kind,
    contentType: { key: typeKey ?? '', alias: typeAlias },
    parent,
    sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : 0,
    template: nullableStr(raw.template) ?? null,
    variants,
    values,
  }
}

function parseManifest(text: string, problems: BundleProblem[]): BundleManifest | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    problems.push({ file: MANIFEST_FILE, message: `not JSON: ${(error as Error).message}` })
    return undefined
  }
  if (!isRecord(raw)) {
    problems.push({ file: MANIFEST_FILE, message: 'not an object' })
    return undefined
  }
  const formatVersion = typeof raw.formatVersion === 'number' ? raw.formatVersion : undefined
  if (formatVersion === undefined) {
    problems.push({ file: MANIFEST_FILE, message: 'no formatVersion' })
    return undefined
  }
  if (formatVersion > BUNDLE_FORMAT_VERSION) {
    problems.push({
      file: MANIFEST_FILE,
      message: `format ${formatVersion} is newer than this version understands (${BUNDLE_FORMAT_VERSION}) — upgrade bunbraco to import it`,
    })
    return undefined
  }
  const provenance = isRecord(raw.provenance) ? raw.provenance : {}
  const selector = isRecord(raw.selector) ? raw.selector : {}
  const dependencies = isRecord(raw.dependencies) ? raw.dependencies : {}
  const schema = isRecord(dependencies.schema) ? dependencies.schema : {}
  const keys = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap((k) => (typeof k === 'string' ? [k] : [])) : []

  return {
    formatVersion,
    id: str(raw.id) ?? '',
    ...(str(raw.label) ? { label: str(raw.label) as string } : {}),
    createdAt: str(raw.createdAt) ?? '',
    createdBy: str(raw.createdBy) ?? '',
    integrity: str(raw.integrity) ?? '',
    snapshot: raw.snapshot === 'drafts' ? 'drafts' : 'published',
    provenance: {
      siteName: str(provenance.siteName) ?? '',
      schemaVersion: str(provenance.schemaVersion) ?? '',
      schemaRevision: str(provenance.schemaRevision) ?? '',
      schemaHash: nullableStr(provenance.schemaHash) ?? null,
    },
    selector: {
      roots: keys(selector.roots),
      descendants: selector.descendants !== false,
      asGiven: keys(selector.asGiven),
    },
    counts: isRecord(raw.counts) ? (raw.counts as BundleManifest['counts']) : {},
    dependencies: {
      carried: keys(dependencies.carried),
      expected: Array.isArray(dependencies.expected)
        ? dependencies.expected.flatMap((e) =>
            isRecord(e) && typeof e.key === 'string'
              ? [
                  {
                    key: e.key,
                    objectType: str(e.objectType) ?? '',
                    name: str(e.name) ?? '',
                    why: str(e.why) ?? '',
                  },
                ]
              : [],
          )
        : [],
      schema: {
        contentTypes: Array.isArray(schema.contentTypes)
          ? schema.contentTypes.flatMap((t) =>
              isRecord(t) && typeof t.alias === 'string'
                ? [{ key: str(t.key) ?? '', alias: t.alias }]
                : [],
            )
          : [],
        components: keys(schema.components),
        languages: keys(schema.languages),
      },
    },
    blobs: Array.isArray(raw.blobs)
      ? raw.blobs.flatMap((b) =>
          isRecord(b) && typeof b.key === 'string'
            ? [
                {
                  key: b.key,
                  node: str(b.node) ?? '',
                  etag: nullableStr(b.etag) ?? null,
                  size: typeof b.size === 'number' ? b.size : null,
                  included: b.included === true,
                },
              ]
            : [],
        )
      : [],
    ...(isRecord(raw.carries) ? { carries: parseCarries(raw.carries) } : {}),
  }
}

/**
 * The declared sections, dropping any name this version does not know and any
 * path that tries to climb out of the bundle — a manifest is a file that
 * travelled, so what it names is read, never trusted.
 */
function parseCarries(raw: Record<string, unknown>): Partial<Record<BundleSection, string[]>> {
  const out: Partial<Record<BundleSection, string[]>> = {}
  for (const section of Object.keys(BUNDLE_SECTIONS) as BundleSection[]) {
    const paths = raw[section]
    if (!Array.isArray(paths)) continue
    const safe = paths.flatMap((path) =>
      typeof path === 'string' && sectionOf(path) === section && !path.split('/').includes('..')
        ? [path]
        : [],
    )
    if (safe.length > 0) out[section] = safe.sort()
  }
  return out
}

/** Reads a bundle directory. `set` is undefined when it cannot be trusted at all. */
export function loadBundle(dir: string): LoadedBundle {
  const problems: BundleProblem[] = []
  const blobs = new Map<string, string>()
  const files = new Map<string, string>()
  const manifestFile = join(dir, MANIFEST_FILE)
  if (!existsSync(manifestFile)) {
    problems.push({ file: MANIFEST_FILE, message: `no bundle at ${dir}` })
    return { set: undefined, problems, blobs, files }
  }
  const manifest = parseManifest(readFileSync(manifestFile, 'utf8'), problems)
  if (!manifest) return { set: undefined, problems, blobs, files }

  const nodesDir = join(dir, 'nodes')
  const nodeFiles = existsSync(nodesDir)
    ? readdirSync(nodesDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const read: Array<{ path: string; text?: string; bytes?: Uint8Array }> = nodeFiles.map(
    (name) => ({
      path: `nodes/${name}`,
      text: readFileSync(join(nodesDir, name), 'utf8'),
    }),
  )

  // A blob the manifest says it carries has to be here, and has to be the file
  // the hash was taken over: `included` is a claim, and this is what checks it.
  for (const blob of manifest.blobs) {
    if (!blob.included) continue
    const path = blobPath(blob.key)
    const file = join(dir, path)
    if (!existsSync(file)) {
      problems.push({
        file: path,
        message: 'the manifest says this file is carried, and it is not',
      })
      continue
    }
    blobs.set(blob.key, file)
    read.push({ path, bytes: new Uint8Array(readFileSync(file)) })
  }

  // Every file the manifest says it carries has to be here, and has to be the
  // file the hash was taken over — the same rule as a blob's `included`.
  for (const [, paths] of Object.entries(manifest.carries ?? {})) {
    for (const path of paths as string[]) {
      const file = join(dir, path)
      if (!existsSync(file)) {
        problems.push({
          file: path,
          message: 'the manifest says this file is carried, and it is not',
        })
        continue
      }
      files.set(path, file)
      read.push({ path, text: readFileSync(file, 'utf8') })
    }
  }

  // Before shape: a truncated copy produces confusing field errors otherwise.
  const integrity = bundleIntegrity(read)
  if (manifest.integrity && manifest.integrity !== integrity)
    problems.push({
      file: MANIFEST_FILE,
      message: `integrity does not match the node files (${manifest.integrity} vs ${integrity}) — the bundle is incomplete or was edited`,
    })

  const nodes = read.flatMap((file) => {
    // Only `nodes/` holds nodes. Blobs have no text, and a carried section is a
    // TOML or TSX file that has no business being parsed as one.
    if (file.text === undefined || !file.path.startsWith('nodes/')) return []
    const node = parseNode(file.text, file.path, problems)
    if (node && nodePath(node.key) !== file.path)
      problems.push({
        file: file.path,
        message: `holds node ${node.key}, so it should be named after it`,
      })
    return node ? [node] : []
  })

  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.key)) problems.push({ file: nodePath(node.key), message: 'appears twice' })
    seen.add(node.key)
  }

  return { set: { manifest, nodes }, problems, blobs, files }
}
