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
  type BundleContentMode,
  type BundleManifest,
  type BundleNode,
  type BundleSection,
  type BundleValue,
  type BundleVariant,
  CONTENT_ONLY_FORMAT_VERSION,
  type ContentSet,
  SECTIONS_FORMAT_VERSION,
} from './model.ts'
import { type BundlePeople, sealPeople } from './people.ts'
import { type Seal, sealBytes } from './seal.ts'

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

function value(v: BundleValue, open: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    property: v.property,
    culture: v.culture,
    segment: v.segment,
    editor: v.editor,
    ...(open ? { value: v.value } : {}),
  }
  // Absent rather than empty: a value that refers to nothing should not carry a key.
  if (v.references && v.references.length > 0) out.references = [...v.references].sort()
  return out
}

const byHandle = (a: BundleValue, b: BundleValue) =>
  a.property.localeCompare(b.property) ||
  (a.culture ?? '').localeCompare(b.culture ?? '') ||
  (a.segment ?? '').localeCompare(b.segment ?? '')

/**
 * A node, with its variants and values in a stable order so a diff means
 * something. `sealed` leaves each value's payload and the protected page's
 * usernames out, for `sealedValues` to carry.
 */
export function writeNode(node: BundleNode, sealed = false): string {
  const values = [...node.values].sort(byHandle)
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
    values: values.map((v) => value(v, !sealed)),
    // Absent when there is none, so an older node's bundle is unchanged.
    ...(node.access
      ? {
          access: {
            loginNode: node.access.loginNode,
            errorNode: node.access.errorNode,
            memberGroups: [...node.access.memberGroups].sort(),
            ...(!sealed && node.access.memberUserNames
              ? { memberUserNames: [...node.access.memberUserNames].sort() }
              : {}),
          },
        }
      : {}),
    ...(node.schedule && node.schedule.length > 0
      ? {
          schedule: [...node.schedule]
            .sort((a, b) => a.date.localeCompare(b.date) || a.action.localeCompare(b.action))
            .map((e) => ({ culture: e.culture, action: e.action, date: e.date })),
        }
      : {}),
    ...(node.redirects && node.redirects.length > 0
      ? {
          redirects: [...node.redirects]
            .sort(
              (a, b) =>
                a.path.localeCompare(b.path) || (a.culture ?? '').localeCompare(b.culture ?? ''),
            )
            .map((r) => ({ path: r.path, root: r.root, culture: r.culture })),
        }
      : {}),
  })
}

/** What a node's sealed file holds: its values' payloads, and its protected page's usernames. */
export interface SealedValues {
  values: Array<{
    property: string
    culture: string | null
    segment: string | null
    value: unknown
  }>
  memberUserNames?: string[]
}

export function sealedValues(node: BundleNode): SealedValues {
  return {
    values: [...node.values].sort(byHandle).map((v) => ({
      property: v.property,
      culture: v.culture,
      segment: v.segment,
      value: v.value,
    })),
    ...(node.access?.memberUserNames
      ? { memberUserNames: [...node.access.memberUserNames].sort() }
      : {}),
  }
}

/** Where a node's sealed values sit. */
export const valuesPath = (key: string): string => `values/${key}.json`

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
        components: [...d.schema.components].sort(),
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
    ...(manifest.people ? { people: manifest.people } : {}),
    ...(manifest.seal ? { seal: manifest.seal } : {}),
    ...(manifest.content ? { content: manifest.content } : {}),
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

export interface WriteOptions {
  /**
   * How values, media files and protected-page usernames travel: `open`,
   * `sealed` under `seal`, or `omitted`. Sealed when a seal is given, open
   * otherwise.
   */
  content?: 'open' | BundleContentMode
  /** One per export, from `newSeal`; needed for sealed content and for people. */
  seal?: Seal
  /** Members and users: always sealed. */
  people?: BundlePeople
}

/** Without values, media files or usernames: what `omitted` writes. Pure. */
function withoutContent(node: BundleNode): BundleNode {
  const { access, ...rest } = node
  return {
    ...rest,
    values: [],
    ...(access
      ? {
          access: {
            loginNode: access.loginNode,
            errorNode: access.errorNode,
            memberGroups: access.memberGroups,
          },
        }
      : {}),
  }
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
  options: WriteOptions = {},
): BundleFile[] {
  const seal = options.seal
  const content = options.content ?? (seal ? 'sealed' : 'open')
  if ((content === 'sealed' || options.people) && !seal)
    throw new Error('Sealed content and people need a seal: give a passphrase.')
  const sealing = content === 'sealed'
  const source = content === 'omitted' ? set.nodes.map(withoutContent) : set.nodes
  const carriedBlobs: ReadonlyMap<string, Uint8Array> = content === 'omitted' ? new Map() : blobs

  const sorted = [...source].sort((a, b) => a.key.localeCompare(b.key))
  const nodes: BundleFile[] = sorted.map((node) => ({
    path: nodePath(node.key),
    text: writeNode(node, sealing),
  }))
  const sealedFiles: BundleFile[] =
    sealing && seal
      ? sorted.map((node) => {
          const path = valuesPath(node.key)
          return { path, bytes: sealBytes(seal.key, path, Buffer.from(json(sealedValues(node)))) }
        })
      : []
  const carried: BundleFile[] = [...carriedBlobs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bytes]) => {
      const path = blobPath(key)
      return { path, bytes: sealing && seal ? sealBytes(seal.key, path, bytes) : bytes }
    })

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

  const people = options.people && seal ? sealPeople(options.people, seal) : undefined
  // Rules a node carries beyond its content: an older reader would drop them,
  // and a protected page it dropped would be public.
  const nodeExtras = source.some(
    (n) => n.access || (n.schedule?.length ?? 0) > 0 || (n.redirects?.length ?? 0) > 0,
  )
  const manifest: BundleManifest = {
    ...set.manifest,
    // The oldest version that can read it: content only stays 1, sections
    // need 2, and anything sealed or a node's rules need 3.
    formatVersion:
      people || sealing || nodeExtras
        ? BUNDLE_FORMAT_VERSION
        : extra.length > 0
          ? SECTIONS_FORMAT_VERSION
          : CONTENT_ONLY_FORMAT_VERSION,
    // Without values nothing names a media file, so none is expected either.
    blobs: (content === 'omitted' ? [] : set.manifest.blobs).map((blob) => {
      const bytes = carriedBlobs.get(blob.key)
      return bytes ? { ...blob, included: true, size: bytes.length } : { ...blob, included: false }
    }),
    carries: extra.length > 0 ? carries : undefined,
    people: people?.block,
    seal: seal && (sealing || people) ? seal.params : undefined,
    content: content === 'open' ? undefined : content,
    integrity: bundleIntegrity([
      ...nodes,
      ...sealedFiles,
      ...carried,
      ...extra,
      ...(people?.files ?? []),
    ]),
  }
  return [
    { path: MANIFEST_FILE, text: writeManifest(manifest) },
    ...nodes,
    ...sealedFiles,
    ...carried,
    ...extra,
    ...(people?.files ?? []),
  ]
}
