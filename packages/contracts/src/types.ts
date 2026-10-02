/**
 * Typed access to the generated contract types.
 *
 * `ResponseOf<'GetServerStatus'>` is the exact 200 body the backoffice expects,
 * so a handler that drifts from the contract fails to compile. Regenerate with
 * `bun run generate:types` after re-vendoring OpenApi.json.
 */
import type { components, operations } from '../generated/management-api.d.ts'

export type Schemas = components['schemas']
export type Operations = operations
export type OperationId = keyof operations

type JsonContent<T> = T extends { content: { 'application/json': infer B } } ? B : never

/** The 200/201 JSON response body for an operation, or never if it has none. */
export type ResponseOf<K extends OperationId> = operations[K] extends {
  responses: infer R
}
  ? R extends { 200: infer Ok }
    ? JsonContent<Ok>
    : R extends { 201: infer Created }
      ? JsonContent<Created>
      : never
  : never

/** The JSON request body for an operation, or never if it takes none. */
export type RequestOf<K extends OperationId> = operations[K] extends {
  requestBody?: infer B
}
  ? JsonContent<NonNullable<B>>
  : never

/** Query and path parameters declared for an operation. */
export type ParamsOf<K extends OperationId> = operations[K] extends { parameters: infer P }
  ? P
  : never
