/**
 * Approval: the only path by which anything the assistant proposed reaches the
 * CMS, and a path only a person can take.
 *
 * An approved change is dispatched as the user who approved it, so the same
 * section, start-node and permission checks that guard their own Save guard this
 * too — a proposal is a suggestion, not a capability. The entity is re-read first
 * and the write refused if it moved since the proposal was made, rather than
 * overwriting whatever happened in between.
 */
import { listOperations, loadSpec, type OperationInfo } from '@bunbraco/contracts'
import {
  type ChangesetStore,
  isApprovable,
  type ProposedChange,
  type SchemaProposalPort,
} from './changeset.ts'
import { APPLY_OPERATIONS, type ChangeKind, isForbidden, SCHEMA_KINDS } from './operations.ts'
import type { ManagementCall } from './tools.ts'

export interface ApplyOptions {
  call: ManagementCall
  changesets: ChangesetStore
  operations?: readonly OperationInfo[]
  /** Applies a schema proposal by writing its file and importing it. */
  schema?: SchemaProposalPort
  /**
   * Whether the caller may change schema, which for a dispatched operation
   * `authorization.ts` decides. A schema kind does not pass through it, so the
   * host answers this instead; absent means no.
   */
  maySetSchema?: boolean
}

export interface ApplyOutcome {
  applied: boolean
  status: number | undefined
  error: string | undefined
}

/** How each kind's baseline is re-read, and what part of the response it covers. */
const BASELINE_READS: Partial<
  Record<ChangeKind, { operationId: string; pick?: (body: unknown) => unknown }>
> = {
  document: { operationId: 'GetDocumentById' },
  'document-type': { operationId: 'GetDocumentTypeById' },
  'data-type': { operationId: 'GetDataTypeById' },
  template: {
    operationId: 'GetTemplateById',
    pick: (body) => (body as { content?: string | null }).content ?? null,
  },
}

const digest = (value: unknown): string =>
  new Bun.CryptoHasher('sha256').update(JSON.stringify(value ?? null)).digest('hex')

export async function applyChange(
  change: ProposedChange,
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  const operations = options.operations ?? listOperations(loadSpec())
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]))

  const settle = async (error: string | undefined, status?: number): Promise<ApplyOutcome> => {
    await options.changesets.settle(change.key, {
      status: error === undefined ? 'applied' : 'failed',
      error,
    })
    return { applied: error === undefined, status, error }
  }

  if (!isApprovable(change)) {
    const why =
      change.problems.length > 0
        ? `it has problems that must be fixed first: ${change.problems.map((problem) => problem.message).join('; ')}`
        : `it is already ${change.status}`
    return { applied: false, status: undefined, error: why }
  }

  // Schema kinds are TOML files, not requests: written and imported, not dispatched.
  if (SCHEMA_KINDS.has(change.kind)) {
    if (!options.schema) return await settle('this site does not manage schema as files')
    if (!options.maySetSchema) {
      return await settle('you do not have access to Settings, where types are changed')
    }
    const body = (change.body ?? {}) as { alias?: unknown; toml?: unknown }
    if (typeof body.alias !== 'string' || typeof body.toml !== 'string') {
      return await settle('this proposal is missing its alias or its TOML')
    }
    const problems = await options.schema.validate(change.kind, body.alias, body.toml)
    if (problems.length > 0) {
      return await settle(problems.map((problem) => problem.message).join('; '))
    }
    const applied = await options.schema.apply(change.kind, body.alias, body.toml)
    return await settle(applied.ok ? undefined : (applied.error ?? 'the import refused it'))
  }

  const operationId = APPLY_OPERATIONS[change.kind]
  if (!operationId) return await settle(`${change.kind} has no way to be applied`)
  const operation = byId.get(operationId)
  // Defence against a future edit to APPLY_OPERATIONS rather than a live risk:
  // the boundary test asserts the same thing, and this refuses at runtime too.
  if (!operation || isForbidden(operation)) {
    return await settle(`${operationId} cannot be applied`)
  }

  const baseline = BASELINE_READS[change.kind]
  if (baseline && change.baseline !== undefined) {
    const entity = byId.get(baseline.operationId)
    if (!entity) return await settle(`${baseline.operationId} is missing from the contract`)
    const path = entity.path.replace('{id}', encodeURIComponent(change.params.id ?? ''))
    const current = await options.call({ method: entity.method, path })
    if (current.status !== 200) {
      return await settle(`the item this change applies to could not be read (${current.status})`)
    }
    const now = digest(baseline.pick ? baseline.pick(current.body) : current.body)
    if (now !== change.baseline) {
      return await settle('it changed after this was proposed — ask for it to be proposed again')
    }
  }

  let path = operation.path
  for (const [name, value] of Object.entries(change.params)) {
    path = path.replace(`{${name}}`, encodeURIComponent(value))
  }
  if (path.includes('{')) return await settle(`${operationId} is missing a path parameter`)

  const response = await options.call({ method: operation.method, path, body: change.body })
  if (response.status >= 400) {
    return await settle(
      messageFrom(response.body) ?? `the API refused it (${response.status})`,
      response.status,
    )
  }
  return await settle(undefined, response.status)
}

/** The problem-details message, so a refusal reads as the backoffice would show it. */
function messageFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const details = body as { detail?: unknown; title?: unknown }
  if (typeof details.detail === 'string' && details.detail !== '') return details.detail
  return typeof details.title === 'string' && details.title !== '' ? details.title : undefined
}
