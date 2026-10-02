/**
 * Umbraco's ModelsBuilder, which generates strongly-typed models from the
 * content types. Bunbraco's models are the TypeScript `bunbraco generate`
 * writes from the TOML schema, so the same three operations describe it.
 */

/** Umbraco's `OutOfDateType`: `Unknown` when staleness cannot be determined. */
export type OutOfDateStatus = 'OutOfDate' | 'Current' | 'Unknown'

export interface ModelsBuilderInfo {
  /** One of Umbraco's `ModelsMode` strings; the client explains only those. */
  mode: string
  canGenerate: boolean
  outOfDateModels: boolean
  trackingOutOfDateModels: boolean
  lastError: string | null
  version: string | null
  modelsNamespace: string | null
}

export interface ModelsBuilderPort {
  info(): Promise<ModelsBuilderInfo>
  status(): Promise<OutOfDateStatus>
  /** Writes the models; the message of a failure is kept for `info().lastError`. */
  build(): Promise<{ ok: true } | { ok: false; error: string }>
}
