/**
 * Contract-first router: every route comes from the vendored OpenAPI document,
 * so a path that is not in the contract cannot be served, and an operation in
 * the contract without a handler answers 501 rather than 404.
 */
import { type HttpMethod, listOperations, loadSpec, type OperationInfo } from '@bunbraco/contracts'
import {
  applyNotifications,
  type EventMessage,
  type GroupGrant,
  notFound,
  notImplemented,
  problemResponse,
  type StartNodes,
  unauthorized,
} from '@bunbraco/core'
import { authorize, LOCAL_LOGIN_OPERATIONS, type NodeLookup } from './authorization.ts'
import { type ServerEvent, serverEventFor } from './server-events.ts'

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
}

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

  constructor(options: RouterOptions = {}) {
    const operations = options.operations ?? listOperations(loadSpec())
    this.operations = operations
    this.#authenticate = options.authenticate
    this.#onNotImplemented = options.onNotImplemented
    this.#onServerEvent = options.onServerEvent
    this.#nodes = options.nodes
    this.#allowLocalLogin = options.allowLocalLogin ?? true
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
    const response = handler
      ? await handler({ request, url, params, operation, notifications, principal })
      : problemResponse(notImplemented(operation.operationId))
    if (handler && this.#onServerEvent) {
      const event = serverEventFor(operation, params, response)
      if (event) this.#onServerEvent(event)
    }
    const headers = new Headers(response.headers)
    applyNotifications(headers, request.method, notifications)
    headers.set('cache-control', 'no-store')
    return new Response(response.body, { status: response.status, headers })
  }
}
