/**
 * Contract-first router: every route comes from the vendored OpenAPI document,
 * so a path that is not in the contract cannot be served, and an operation in
 * the contract without a handler answers 501 rather than 404.
 */

import { type HttpMethod, listOperations, loadSpec, type OperationInfo } from '@crombolo/contracts'
import {
  applyNotifications,
  type EventMessage,
  type GroupGrant,
  notFound,
  notImplemented,
  problemResponse,
  type StartNodes,
  unauthorized,
} from '@crombolo/core'
import {
  type AuditPlan,
  type AuditRecord,
  type AuditSink,
  auditDrafts,
  auditNamesFirst,
  auditPlanFor,
  auditReadsBody,
} from './audit.ts'
import { authorize, LOCAL_LOGIN_OPERATIONS, type NodeLookup } from './authorization.ts'
import {
  changeReadsBody,
  contentChangeFor,
  type RaisedContentChange,
} from './notification-events.ts'
import { type ServerEvent, serverEventFor } from './server-events.ts'
import { type RaisedWebhookEvent, webhookEventFor } from './webhook-events.ts'

/**
 * Resolved back-office identity, assembled from a reference token plus the
 * user's group membership. Everything needed to authorise a request is here, so
 * a handler never queries the identity tables itself.
 */
export interface Principal {
  /** The user's key (a uuid), which is what the API exposes as its id. */
  id: string
  userName: string
  name: string
  email: string
  isAdmin: boolean
  languageIsoCode: string | undefined
  avatarUrls: string[]
  /** Section manifest aliases, e.g. `Umb.Section.Content`. */
  allowedSections: string[]
  /** Permission verbs granted globally by the user's groups. */
  permissions: string[]
  groupKeys: string[]
  hasAccessToAllLanguages: boolean
  /** Content languages the user may work in; everything when `hasAccessToAllLanguages`. */
  languages: string[]
  /** Where the user may work in each tree, groups' and own start nodes combined. */
  startNodes: { document: StartNodes; media: StartNodes; element: StartNodes }
  /** Each group's verbs, for per-node permission checks. */
  groups: GroupGrant[]
}

export interface RequestContext {
  request: Request
  url: URL
  /** Path parameters, keyed by the name used in the contract. */
  params: Readonly<Record<string, string>>
  operation: OperationInfo
  /** Messages surfaced to the editor through the Umb-Notifications header. */
  notifications: EventMessage[]
  /**
   * Present only when the request authenticated. The router already rejected
   * unauthenticated requests to secured operations, so a handler for a secured
   * operation can rely on this being set.
   */
  principal: Principal | undefined
}

export type Authenticator = (request: Request) => Promise<Principal | undefined>

export interface RouterOptions {
  operations?: readonly OperationInfo[]
  /** Resolves the caller's identity. Omitted means every request is anonymous. */
  authenticate?: Authenticator
  /** Told about every request that reached an operation with no handler. */
  onNotImplemented?: (operation: OperationInfo, request: Request) => void
  /** Told about every change a handler made, before its response is sent. */
  onServerEvent?: (event: ServerEvent) => void
  /** Node positions for per-node permission checks; without it only section access is enforced. */
  nodes?: NodeLookup
  /** Whether users may sign in with a password, which opens the password-reset endpoints to everyone. */
  allowLocalLogin?: boolean
  /** Where every successful change is recorded. docs/audit-log.md. */
  audit?: AuditSink
  /** Where a request came from, for its audit entry. */
  clientAddress?: (request: Request) => ClientAddress
  /** Answers an error a handler threw; undefined lets it propagate. */
  onError?: (error: unknown) => Response | undefined
  /** Told about every webhook event a successful operation raises. */
  onWebhookEvent?: (event: RaisedWebhookEvent) => void
  /** A change to a page that people can subscribe to, and who made it (story 045). */
  onContentChange?: (change: RaisedContentChange, principal: Principal | undefined) => void
}

export interface ClientAddress {
  /** The peer that connected: a proxy, when there is one. */
  ipAddress: string | null
  /** What a proxy said the client was; anyone can send it, so it is kept apart. */
  forwardedFor: string | null
}

const forwardedOnly = (request: Request): ClientAddress => ({
  ipAddress: null,
  forwardedFor: request.headers.get('x-forwarded-for'),
})

export type OperationHandler = (ctx: RequestContext) => Response | Promise<Response>

interface CompiledRoute {
  operation: OperationInfo
  segments: string[]
  paramNames: (string | undefined)[]
  staticCount: number
}

export class ManagementApiRouter {
  readonly operations: readonly OperationInfo[]
  readonly #handlers = new Map<string, OperationHandler>()
  readonly #byMethodAndLength = new Map<string, CompiledRoute[]>()
  readonly #authenticate: Authenticator | undefined
  readonly #onNotImplemented: RouterOptions['onNotImplemented']
  readonly #onServerEvent: RouterOptions['onServerEvent']
  readonly #nodes: NodeLookup | undefined
  readonly #allowLocalLogin: boolean
  readonly #audit: AuditSink | undefined
  readonly #clientAddress: (request: Request) => ClientAddress
  readonly #onError: RouterOptions['onError']
  readonly #onWebhookEvent: RouterOptions['onWebhookEvent']
  readonly #onContentChange: RouterOptions['onContentChange']

  constructor(options: RouterOptions = {}) {
    const operations = options.operations ?? listOperations(loadSpec())
    this.operations = operations
    this.#authenticate = options.authenticate
    this.#onNotImplemented = options.onNotImplemented
    this.#onServerEvent = options.onServerEvent
    this.#nodes = options.nodes
    this.#allowLocalLogin = options.allowLocalLogin ?? true
    this.#audit = options.audit
    this.#clientAddress = options.clientAddress ?? forwardedOnly
    this.#onError = options.onError
    this.#onWebhookEvent = options.onWebhookEvent
    this.#onContentChange = options.onContentChange
    for (const operation of operations) {
      const segments = operation.path.split('/').filter((s) => s.length > 0)
      const paramNames = segments.map((s) =>
        s.startsWith('{') && s.endsWith('}') ? s.slice(1, -1) : undefined,
      )
      const route: CompiledRoute = {
        operation,
        segments,
        paramNames,
        staticCount: paramNames.filter((p) => p === undefined).length,
      }
      const key = `${operation.method}:${segments.length}`
      const bucket = this.#byMethodAndLength.get(key)
      if (bucket) bucket.push(route)
      else this.#byMethodAndLength.set(key, [route])
    }
    // Prefer the most literal route when several shapes match.
    for (const bucket of this.#byMethodAndLength.values()) {
      bucket.sort((a, b) => b.staticCount - a.staticCount)
    }
  }

  /** Register the implementation of a contract operation. */
  handle(operationId: string, handler: OperationHandler): this {
    if (!this.operations.some((o) => o.operationId === operationId)) {
      throw new Error(`Unknown operationId '${operationId}' — it is not in the contract.`)
    }
    this.#handlers.set(operationId, handler)
    return this
  }

  has(operationId: string): boolean {
    return this.#handlers.has(operationId)
  }

  get implementedCount(): number {
    return this.#handlers.size
  }

  match(
    method: string,
    pathname: string,
  ): { operation: OperationInfo; params: Record<string, string> } | undefined {
    const segments = pathname.split('/').filter((s) => s.length > 0)
    const bucket = this.#byMethodAndLength.get(
      `${method.toLowerCase() as HttpMethod}:${segments.length}`,
    )
    if (!bucket) return undefined
    for (const route of bucket) {
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < segments.length; i++) {
        const name = route.paramNames[i]
        const segment = segments[i] as string
        if (name === undefined) {
          if (route.segments[i] !== segment) {
            matched = false
            break
          }
        } else {
          params[name] = decodeURIComponent(segment)
        }
      }
      if (matched) return { operation: route.operation, params }
    }
    return undefined
  }

  async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const matched = this.match(request.method, url.pathname)
    if (!matched) {
      return problemResponse(
        notFound(
          'Not Found',
          `No operation in the contract matches ${request.method} ${url.pathname}`,
        ),
      )
    }
    const { operation, params } = matched
    const notifications: EventMessage[] = []

    // Authorisation is driven by the contract: the document requires a
    // back-office user globally, and 10 operations opt out with `security: []`.
    const principal = await this.#authenticate?.(request)
    const anonymous =
      operation.anonymous ||
      (this.#allowLocalLogin && LOCAL_LOGIN_OPERATIONS.has(operation.operationId))
    if (!anonymous && !principal) {
      return problemResponse(unauthorized())
    }
    // Umbraco answers a failed authorization policy with a bare 403.
    if (principal && !(await authorize(operation, params, request, principal, this.#nodes)))
      return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } })

    const handler = this.#handlers.get(operation.operationId)
    if (!handler) this.#onNotImplemented?.(operation, request)
    const plan = handler && this.#audit ? auditPlanFor(operation.operationId) : undefined
    const audit = plan ? await this.#beforeAudit(plan, params, request) : undefined
    const changeBody =
      handler && this.#onContentChange && changeReadsBody(operation.operationId)
        ? await request
            .clone()
            .json()
            .catch(() => undefined)
        : undefined
    const response = handler
      ? await this.#run(handler, { request, url, params, operation, notifications, principal })
      : problemResponse(notImplemented(operation.operationId))
    if (plan && audit && response.status >= 200 && response.status < 300)
      await this.#recordAudit(plan, audit, params, request, response, principal)
    if (handler && this.#onServerEvent) {
      const event = serverEventFor(operation, params, response)
      if (event) this.#onServerEvent(event)
    }
    if (handler && this.#onWebhookEvent) {
      const event = webhookEventFor(operation.operationId, params, response)
      if (event) this.#onWebhookEvent(event)
    }
    if (handler && this.#onContentChange) {
      const change = contentChangeFor(operation.operationId, params, response, changeBody)
      if (change) this.#onContentChange(change, principal)
    }
    const headers = new Headers(response.headers)
    applyNotifications(headers, request.method, notifications)
    headers.set('cache-control', 'no-store')
    return new Response(response.body, { status: response.status, headers })
  }

  async #run(handler: OperationHandler, ctx: RequestContext): Promise<Response> {
    try {
      return await handler(ctx)
    } catch (error) {
      const answered = this.#onError?.(error)
      if (answered) return answered
      throw error
    }
  }

  /** Reads what the entry needs before the handler consumes the body or removes the item. */
  async #beforeAudit(
    plan: AuditPlan,
    params: Readonly<Record<string, string>>,
    request: Request,
  ): Promise<AuditState> {
    const body = auditReadsBody(plan)
      ? await request
          .clone()
          .json()
          .catch(() => undefined)
      : undefined
    const named = new Map<string, Subject>()
    if (auditNamesFirst(plan) && this.#audit)
      for (const draft of auditDrafts(plan, params, new Response(), body))
        if (draft.entityKey)
          named.set(draft.entityKey, await this.#audit.describe(draft.entityType, draft.entityKey))
    return { body, named }
  }

  async #recordAudit(
    plan: AuditPlan,
    state: AuditState,
    params: Readonly<Record<string, string>>,
    request: Request,
    response: Response,
    principal: Principal | undefined,
  ): Promise<void> {
    const sink = this.#audit
    if (!sink) return
    const address = this.#clientAddress(request)
    let detail: string | null = null
    if (plan.related) {
      const names: string[] = []
      for (const key of plan.related.keys(state.body))
        names.push((await sink.describe(plan.related.entityType, key)).entityName ?? key)
      detail = `${plan.related.label}: ${names.length > 0 ? names.join(', ') : 'none'}`
    }
    const records: AuditRecord[] = []
    for (const draft of auditDrafts(plan, params, response, state.body)) {
      const key = draft.entityKey ?? (plan.entityType === 'User' ? (principal?.id ?? null) : null)
      const subject = key
        ? (state.named.get(key) ?? (await sink.describe(draft.entityType, key)))
        : undefined
      // A reset link or an accepted invite is anonymous: the user it names is who acted.
      const self = !principal && draft.entityType === 'User' && subject
      records.push({
        ...draft,
        entityType: subject?.entityType ?? draft.entityType,
        entityKey: subject?.entityKey ?? key,
        entityName: subject?.entityName ?? null,
        detail,
        userKey: principal?.id ?? (self ? subject.entityKey : null),
        userName: principal?.name ?? (self ? subject.entityName : null),
        ipAddress: address.ipAddress,
        forwardedFor: address.forwardedFor,
      })
    }
    await sink.record(records)
  }
}

interface Subject {
  entityType: string
  entityKey: string
  entityName: string | null
}

interface AuditState {
  body: unknown
  named: Map<string, Subject>
}
