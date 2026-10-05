/**
 * Model → canonical JSON.
 *
 * Our own writer, for a fixed vocabulary, for the same reason the schema package
 * has one: a bundle is reviewed in a diff and committed, so the same content must
 * serialise the same way every time. Keys are emitted in a declared order rather
 * than sorted generically, and a property's `value` is passed through untouched —
 * it is an editor's own payload, often JSON in a string, and reordering inside it
 * would rewrite somebody else's data to no purpose.
 *
 * `read(write(x))` must equal `x` — the tests hold it to that.
 */
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_SECTIONS,
  type BundleManifest,
  type BundleNode,
  type BundleSection,
  type BundleValue,
  type BundleVariant,
  CONTENT_ONLY_FORMAT_VERSION,
  type ContentSet,
} from './model.ts'

/** One file of a written bundle, ready to be put on disk or into a store. */
export interface BundleFile {
  /** Relative to the bundle root, `/`-separated. */
  path: string
  text?: string
  /** A media file's bytes; `text` and `bytes` are never both set. */
  bytes?: Uint8Array
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

function variant(v: BundleVariant): Record<string, unknown> {
  return { culture: v.culture, segment: v.segment, name: v.name, published: v.published }
}

function value(v: BundleValue): Record<string, unknown> {
  const out: Record<string, unknown> = {
    property: v.property,
    culture: v.culture,
    segment: v.segment,
    editor: v.editor,
    value: v.value,
  }
  // Absent rather than empty: a value that refers to nothing should not carry a key.
  if (v.references && v.references.length > 0) out.references = [...v.references].sort()
  return out
}

/** A node, with its variants and values in a stable order so a diff means something. */
export function writeNode(node: BundleNode): string {
  const values = [...node.values].sort(
    (a, b) =>
      a.property.localeCompare(b.property) ||
      (a.culture ?? '').localeCompare(b.culture ?? '') ||
      (a.segment ?? '').localeCompare(b.segment ?? ''),
  )
  const variants = [...node.variants].sort(
    (a, b) =>
      (a.culture ?? '').localeCompare(b.culture ?? '') ||
      (a.segment ?? '').localeCompare(b.segment ?? ''),
  )
  return json({
    key: node.key,
    kind: node.kind,
    contentType: { key: node.contentType.key, alias: node.contentType.alias },
    parent: node.parent,
    sortOrder: node.sortOrder,
    template: node.template,
    variants: variants.map(variant),
    values: values.map(value),
  })
}

export function writeManifest(manifest: BundleManifest): string {
  const d = manifest.dependencies
  return json({
    formatVersion: manifest.formatVersion,
    id: manifest.id,
    ...(manifest.label ? { label: manifest.label } : {}),
    createdAt: manifest.createdAt,
    createdBy: manifest.createdBy,
    integrity: manifest.integrity,
    snapshot: manifest.snapshot,
    provenance: {
      siteName: manifest.provenance.siteName,
      schemaVersion: manifest.provenance.schemaVersion,
      schemaRevision: manifest.provenance.schemaRevision,
      schemaHash: manifest.provenance.schemaHash,
    },
    selector: {
      roots: manifest.selector.roots,
      descendants: manifest.selector.descendants,
      asGiven: manifest.selector.asGiven,
    },
    counts: manifest.counts,
    dependencies: {
      carried: [...d.carried].sort(),
      expected: [...d.expected]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((e) => ({ key: e.key, objectType: e.objectType, name: e.name, why: e.why })),
      schema: {
        contentTypes: [...d.schema.contentTypes]
          .sort((a, b) => a.alias.localeCompare(b.alias))
          .map((t) => ({ key: t.key, alias: t.alias })),
        templates: [...d.schema.templates].sort(),
        languages: [...d.schema.languages].sort(),
      },
    },
    blobs: [...manifest.blobs]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((b) => ({
        key: b.key,
        node: b.node,
        etag: b.etag,
        size: b.size,
        included: b.included,
      })),
    // Absent on a content-only bundle, so version 1 output is unchanged.
    ...(manifest.carries && Object.keys(manifest.carries).length > 0
      ? { carries: sortedCarries(manifest.carries) }
      : {}),
  })
}

/** Sections in a declared order, each one's paths sorted, so a diff means something. */
function sortedCarries(
  carries: Partial<Record<BundleSection, string[]>>,
): Partial<Record<BundleSection, string[]>> {
  const out: Partial<Record<BundleSection, string[]>> = {}
  for (const section of Object.keys(BUNDLE_SECTIONS) as BundleSection[]) {
    const paths = carries[section]
    if (paths && paths.length > 0) out[section] = [...paths].sort()
  }
  return out
}

export const nodePath = (key: string): string => `nodes/${key}.json`

/** The section a carried file belongs to, from the directory it sits in. */
export function sectionOf(path: string): BundleSection | undefined {
  if (path === `${BUNDLE_SECTIONS.dictionary}.udt`) return 'dictionary'
  const top = path.split('/')[0]
  for (const [section, dir] of Object.entries(BUNDLE_SECTIONS))
    if (top === dir) return section as BundleSection
  return undefined
}

/** Where a media file's bytes sit when the bundle carries them. */
export const blobPath = (key: string): string => `blobs/${key}`

export const MANIFEST_FILE = 'bundle.json'

/**
 * A hash over everything the bundle carries, in path order, so a bundle that
 * was copied half-way is refused rather than imported as though it were whole.
 * The manifest is excluded — it carries the hash. Media files are hashed by
 * their bytes, which is what makes `--with-blobs` a claim the reader can check.
 */
export function bundleIntegrity(files: readonly BundleFile[]): string {
  const hasher = new Bun.CryptoHasher('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (file.path === MANIFEST_FILE) continue
    hasher.update(file.path)
    hasher.update('\0')
    hasher.update(file.bytes ?? (file.text as string))
    hasher.update('\n')
  }
  return `sha256-${hasher.digest('hex')}`
}

/**
 * The whole bundle as files. The integrity hash is computed over them and
 * written into the manifest, so the caller passes a manifest whose `integrity`
 * is ignored.
 *
 * `blobs` are the media files to carry, by store key. Whether each one is
 * carried is decided here rather than taken from the manifest: the exporter
 * knows the flag was passed, and only the caller holding the bytes knows
 * whether the file was actually there to read.
 */
export function writeBundle(
  set: ContentSet,
  blobs: ReadonlyMap<string, Uint8Array> = new Map(),
  sections: readonly BundleFile[] = [],
): BundleFile[] {
  const nodes: BundleFile[] = [...set.nodes]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((node) => ({ path: nodePath(node.key), text: writeNode(node) }))
  const carried: BundleFile[] = [...blobs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bytes]) => ({ path: blobPath(key), bytes }))

  // A file in no known section would travel without being declared, so it
  // would not be hashed and a reader would never look for it. Refused here
  // rather than written and silently ignored at the far end.
  const extra = [...sections].sort((a, b) => a.path.localeCompare(b.path))
  const carries: Partial<Record<BundleSection, string[]>> = {}
  for (const file of extra) {
    const section = sectionOf(file.path)
    if (!section) throw new Error(`${file.path} is not in a bundle section`)
    carries[section] = [...(carries[section] ?? []), file.path]
  }

  const manifest: BundleManifest = {
    ...set.manifest,
    // Content-only bundles keep saying 1, so an older node can still read one.
    formatVersion: extra.length > 0 ? BUNDLE_FORMAT_VERSION : CONTENT_ONLY_FORMAT_VERSION,
    blobs: set.manifest.blobs.map((blob) => {
      const bytes = blobs.get(blob.key)
      return bytes ? { ...blob, included: true, size: bytes.length } : { ...blob, included: false }
    }),
    carries: extra.length > 0 ? carries : undefined,
    integrity: bundleIntegrity([...nodes, ...carried, ...extra]),
  }
  return [{ path: MANIFEST_FILE, text: writeManifest(manifest) }, ...nodes, ...carried, ...extra]
}
