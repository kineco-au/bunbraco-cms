/** Loads and indexes the vendored Umbraco Management API OpenAPI contract. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SPEC_PATH = join(import.meta.dir, '../OpenApi.json')

export const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export interface OperationInfo {
  operationId: string
  method: HttpMethod
  /** Full path as written in the spec, e.g. /umbraco/management/api/v1/document/{id} */
  path: string
  /** Version segment parsed out of the path, e.g. "1" or "1.1" */
  version: string | undefined
  /** First tag, used to group operations by area. */
  tag: string | undefined
  /** Path segment after the version, e.g. "document" */
  area: string | undefined
  /**
   * True when the operation overrides the document's global security with an
   * empty requirement. Exactly 10 operations do this in Umbraco 18.
   */
  anonymous: boolean
}

export interface OpenApiSpec {
  openapi: string
  info: { title: string; version: string }
  security?: unknown[]
  paths: Record<
    string,
    Record<string, { operationId?: string; tags?: string[]; security?: unknown[] }>
  >
  components: { schemas: Record<string, unknown> }
}

let cached: OpenApiSpec | undefined

export function loadSpec(): OpenApiSpec {
  if (!cached) cached = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiSpec
  return cached
}

export async function loadSpecAsync(): Promise<OpenApiSpec> {
  if (!cached) cached = (await Bun.file(SPEC_PATH).json()) as OpenApiSpec
  return cached
}

const VERSION_RE = /\/api\/v(\d+(?:\.\d+)?)\//

export function parsePath(path: string): { version?: string; area?: string } {
  const m = VERSION_RE.exec(path)
  if (!m) return {}
  const version = m[1]
  const rest = path.slice(m.index + m[0].length)
  const area = rest.split('/')[0] || undefined
  return { version, area }
}

export function listOperations(spec: OpenApiSpec): OperationInfo[] {
  const out: OperationInfo[] = []
  for (const [path, item] of Object.entries(spec.paths)) {
    const { version, area } = parsePath(path)
    for (const method of HTTP_METHODS) {
      const op = item[method]
      if (!op?.operationId) continue
      out.push({
        operationId: op.operationId,
        method,
        path,
        version,
        tag: op.tags?.[0],
        area,
        anonymous: Array.isArray(op.security) && op.security.length === 0,
      })
    }
  }
  return out
}

/** Operation ids must be unique — the generated client keys methods on them. */
export function findDuplicateOperationIds(ops: OperationInfo[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const op of ops) {
    if (seen.has(op.operationId)) dupes.add(op.operationId)
    seen.add(op.operationId)
  }
  return [...dupes]
}
