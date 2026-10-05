/**
 * Created packages: the definitions the Packages section builds, and the zip a
 * download turns one into. `docs/17-packages.md`.
 *
 * The port hands back built bytes rather than a path, because the artifact is
 * never stored — it is serialized when it is asked for, so it cannot be stale.
 */
import type { Page, SkipTake } from '@bunbraco/core'

/** What a package would contain, in the aliases and keys the contract uses. */
export interface PackageDefinitionInput {
  name: string
  /** The content subtree's root, by key, or null when none is picked. */
  contentNodeId: string | null
  contentLoadChildNodes: boolean
  mediaIds: string[]
  mediaLoadChildNodes: boolean
  /** Null and empty mean the same thing; the contract allows both. */
  elementIds: string[] | null
  documentTypes: string[]
  mediaTypes: string[]
  dataTypes: string[]
  templates: string[]
  partialViews: string[]
  stylesheets: string[]
  scripts: string[]
  languages: string[]
  dictionaryItems: string[]
}

export interface PackageDefinition extends PackageDefinitionInput {
  id: string
}

export type PackageWriteResult =
  | { ok: true; id: string }
  | { ok: false; status: PackageWriteStatus }

export type PackageWriteStatus = 'NotFound' | 'DuplicateName' | 'InvalidName'

/** A built package, ready to send. */
export interface BuiltPackage {
  fileName: string
  /** Owns its buffer, so it can be a response body without a copy. */
  bytes: Uint8Array<ArrayBuffer>
}

export interface PackagePort {
  /** Where the Marketplace view points; from the site's configuration. */
  marketplaceUrl(): string
  list(paging: SkipTake): Promise<Page<PackageDefinition>>
  byId(id: string): Promise<PackageDefinition | undefined>
  create(input: PackageDefinitionInput, id: string | undefined): Promise<PackageWriteResult>
  update(id: string, input: PackageDefinitionInput): Promise<PackageWriteResult>
  remove(id: string): Promise<'deleted' | 'notFound'>
  /** Serializes and zips the definition now; undefined when it is gone. */
  build(id: string): Promise<BuiltPackage | undefined>
}
