/**
 * The bundle: content selected out of one environment and reviewable on its way
 * to another. `docs/13-content-transfer.md`.
 *
 * Everything travels by uuid and alias, never by integer id, because the ids
 * differ between environments and the keys do not. A content type is matched by
 * key first — tooling writes keys into `schema/*.toml`, so they are stable
 * across environments — with the alias as the readable fallback.
 */

/** Bumped when a change to the shapes below stops an older reader understanding a bundle. */
export const BUNDLE_FORMAT_VERSION = 1

/**
 * The kinds that travel. `member` is deliberately absent: members are personal
 * data, and a bundle is a file that gets copied around and committed.
 */
export type BundleKind = 'document' | 'media' | 'element' | 'blueprint'

/** Which snapshot of a node's values the bundle carries. */
export type BundleSnapshot = 'published' | 'drafts'

export interface BundleValue {
  property: string
  culture: string | null
  segment: string | null
  /** The editor that wrote it, so the destination can refuse a property whose editor changed. */
  editor: string
  value: unknown
  /** Node keys this value refers to, extracted at export so the importer need not re-parse. */
  references?: string[]
}

/**
 * One culture (or the invariant `null`) of a node: its name and whether it was
 * published at the source. Shaped to feed the repository's own variant input.
 */
export interface BundleVariant {
  culture: string | null
  segment: string | null
  name: string
  published: boolean
}

export interface BundleNode {
  key: string
  kind: BundleKind
  contentType: { key: string; alias: string }
  /** The parent's key, or null for a node at the tree root. */
  parent: string | null
  sortOrder: number
  /** A template alias — a template is `Views/<alias>.tsx`, so aliases travel, not keys. */
  template: string | null
  variants: BundleVariant[]
  values: BundleValue[]
}

/** Something the bundle refers to but does not carry: it must already exist at the destination. */
export interface BundleDependency {
  key: string
  objectType: string
  name: string
  /** Why it is needed, in words, so a blocking finding can explain itself. */
  why: string
}

/** A media file the bundle's media nodes name. Blobs travel only when asked for. */
export interface BundleBlob {
  /** The media store key, as the value names it. */
  key: string
  etag: string | null
  size: number | null
  included: boolean
  /** The media node that names it. */
  node: string
}

export interface BundleDependencies {
  /** Keys carried in the bundle. */
  carried: string[]
  /** Keys that must already exist at the destination. */
  expected: BundleDependency[]
  /** What the destination's schema and views must provide. */
  schema: {
    contentTypes: Array<{ key: string; alias: string }>
    templates: string[]
    languages: string[]
  }
}

/**
 * Where a bundle came from. Recorded and printed, never gated on: development
 * runs at revision 0 by design, so refusing a bundle whose revision is higher
 * than the destination's would refuse every transfer out of production. What
 * the destination actually has to satisfy is checked element by element.
 */
export interface BundleProvenance {
  schemaVersion: string
  schemaRevision: string
  schemaHash: string | null
  siteName: string
}

export interface BundleSelector {
  /** The resolved subtree roots. */
  roots: string[]
  descendants: boolean
  /** What was typed on the command line, for readability when a path was given. */
  asGiven: string[]
}

export interface BundleManifest {
  formatVersion: number
  id: string
  createdAt: string
  createdBy: string
  /** `sha256-…` over the node files, so a half-copied bundle is refused rather than imported. */
  integrity: string
  snapshot: BundleSnapshot
  provenance: BundleProvenance
  selector: BundleSelector
  counts: Partial<Record<BundleKind, number>>
  dependencies: BundleDependencies
  blobs: BundleBlob[]
}

/**
 * A bundle read into memory: the manifest and its nodes. Named for
 * `SchemaSet` in `@bunbraco/schema`, which plays the same part for structure.
 */
export interface ContentSet {
  manifest: BundleManifest
  nodes: BundleNode[]
}

/** A problem with the bundle itself, as opposed to a finding about applying it. */
export interface BundleProblem {
  file: string
  message: string
}
