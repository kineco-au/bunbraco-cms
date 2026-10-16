/**
 * The bundle: content selected out of one environment and reviewable on its way
 * to another. `docs/content-transfer.md`.
 *
 * Everything travels by uuid and alias, never by integer id, because the ids
 * differ between environments and the keys do not. A content type is matched by
 * key first — tooling writes keys into `schema/*.toml`, so they are stable
 * across environments — with the alias as the readable fallback.
 */

import type { BundlePeople, PeopleBlock } from './people.ts'
import type { SealParameters } from './seal.ts'

/** Bumped when a change to the shapes below stops an older reader understanding a bundle. */
export const BUNDLE_FORMAT_VERSION = 3

/** What a bundle with sections and nothing sealed writes: version 2 readers still read it. */
export const SECTIONS_FORMAT_VERSION = 2

/**
 * The version a bundle carrying only content is still written as.
 *
 * A content-only bundle is byte-for-byte what version 1 was, so it keeps saying
 * 1 and an older node can still read it. Only a bundle that carries a section
 * beyond its content needs a reader that knows about `carries`, and that one
 * says 2 — which an older node refuses with a message naming the upgrade,
 * rather than failing an integrity check it cannot explain.
 */
export const CONTENT_ONLY_FORMAT_VERSION = 1

/**
 * The sections a bundle can carry beyond its content, and the directory each
 * one occupies.
 *
 * Logical names, not the destination's directory names: a site may hold its
 * components anywhere (`componentsDir`), so the artifact names what a file *is*
 * and the importer decides where it goes. A bundle written against one site's
 * layout therefore installs into another's.
 *
 * There is one section for components, not two. Umbraco's split of templates
 * and partial views was a Razor concern (`docs/rendering.md`), and a bundle
 * that carried it would push the distinction back into every site that
 * installed one.
 */
export const BUNDLE_SECTIONS = {
  schema: 'schema',
  components: 'components',
  styles: 'styles',
  scripts: 'scripts',
  dictionary: 'dictionary',
} as const

export type BundleSection = keyof typeof BUNDLE_SECTIONS

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
  /** Undefined while the bundle's content is sealed. */
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

/**
 * A protected page: who may see it, by member group name, and where a
 * visitor is sent. The usernames are personal, so they travel with the values.
 */
export interface BundleAccess {
  loginNode: string
  errorNode: string
  memberGroups: string[]
  /** Absent while sealed, or when the bundle carries no content. */
  memberUserNames?: string[]
}

/** A publish or unpublish waiting for its time. */
export interface BundleSchedule {
  culture: string | null
  action: 'publish' | 'unpublish'
  /** ISO 8601, UTC. */
  date: string
}

/** A route the page used to answer on, which redirects to it. */
export interface BundleRedirect {
  path: string
  /** The hostname root it was under, by key; null for none. */
  root: string | null
  culture: string | null
}

export interface BundleNode {
  key: string
  kind: BundleKind
  contentType: { key: string; alias: string }
  /** The parent's key, or null for a node at the tree root. */
  parent: string | null
  sortOrder: number
  /** A component alias — the path under `components/`, so aliases travel, not keys. */
  template: string | null
  variants: BundleVariant[]
  values: BundleValue[]
  access?: BundleAccess
  schedule?: BundleSchedule[]
  redirects?: BundleRedirect[]
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
    components: string[]
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
  /** The CMS version that wrote the bundle (story 104). Absent on bundles written before it. */
  cmsVersion?: string
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
  /**
   * What a person calls this bundle — a created package's name, when that is
   * where it came from.
   *
   * It travels with the artifact rather than being supplied at import time, so
   * a downloaded bundle still knows what it is: two files are otherwise
   * distinguishable only by filename, which is the first thing to be lost.
   */
  label?: string
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
  /**
   * The files this bundle carries beyond its content and media, by section, in
   * path order — the structure and the views that make a bundle installable
   * into a site that has neither.
   *
   * A claim the reader checks, exactly as `blobs.included` is: every path named
   * here has to be present, and the integrity hash covers it. Absent on a
   * content-only bundle, which is what version 1 always was.
   */
  carries?: Partial<Record<BundleSection, string[]>>
  /**
   * Members and users, sealed (story 071): counts and how to derive the key,
   * never who. Present only on a bundle exported with them — format 3, which an
   * older reader refuses by name rather than half-reading.
   */
  people?: PeopleBlock
  /** How values, media files and people are sealed: the salt and cost, never the key. */
  seal?: SealParameters
  /**
   * `sealed`: values and media files are under `seal`. `omitted`: exported
   * without them, so an import names and places pages and writes no value.
   * Absent: in the open.
   */
  content?: BundleContentMode
  /**
   * `site`: a whole site (story 104) — every node, the whole schema and every
   * file — which an import replaces a site with rather than overlays. Absent: a
   * selection, overlaid as always.
   */
  scope?: 'site'
  /**
   * `omitted`: a whole-site file written without its media files (`--no-media`).
   * `referenced`: without them because they move one at a time between the
   * stores of a remote and the CLI (story 107): every blob is named, none is in
   * the file, and the file is no use away from its remote.
   */
  media?: 'omitted' | 'referenced'
  /**
   * The server bundles the site wires, by package name, at the versions that
   * wrote it. An import refuses when the destination lacks one or has an older
   * version, naming it.
   */
  requires?: Record<string, string>
}

export type BundleContentMode = 'sealed' | 'omitted'

/**
 * A bundle read into memory: the manifest and its nodes. Named for
 * `SchemaSet` in `@crombolo/schema`, which plays the same part for structure.
 */
export interface ContentSet {
  manifest: BundleManifest
  nodes: BundleNode[]
  /** True while the values are still sealed: `openBundle` with the passphrase first. */
  sealed?: boolean
  /** The people, once opened. */
  people?: BundlePeople
}

/** A problem with the bundle itself, as opposed to a finding about applying it. */
export interface BundleProblem {
  file: string
  message: string
}
