/**
 * The assistant's HTTP surface, mounted only when `assistant` is configured.
 *
 * Every route needs a signed-in backoffice user, and every CMS call the assistant
 * makes is re-issued through the Management API router carrying that user's own
 * cookies — so `authorization.ts` applies the same section, start-node and
 * permission checks it applies to the editor's own clicks. Nothing here has a
 * privileged path to the database.
 *
 * The approval routes are the only way a proposal reaches the CMS, and they are
 * reachable only from the backoffice: the MCP endpoint deliberately has no
 * equivalent.
 */

import { hasSection, type Principal } from '@bunbraco/api-management'
import {
  type AssistantProvider,
  applyChange,
  type Changeset,
  type ChangesetStore,
  createToolHost,
  describeChange,
  EDITABLE_FIELDS,
  effectOf,
  handleMcpRequest,
  type ManagementCall,
  type ProposedChange,
  type ProviderMessage,
  type ProviderStatus,
  reviewChange,
  runConversation,
  type SchemaProposalPort,
  scanTemplateSource,
  systemPrompt,
} from '@bunbraco/assistant'
import { listOperations, loadSpec } from '@bunbraco/contracts'
import type { Db } from '@bunbraco/data'
import { createChangesetStore } from './adapters/assistant.ts'
import { logger } from './logging.ts'

const log = logger('Assistant')

const PART_KINDS = new Set(['text', 'tool-use', 'tool-result'])

/**
 * How much of a client-supplied transcript is sent back to the model.
 *
 * The browser holds the conversation and returns it each turn, so without a
 * ceiling the caller decides how many tokens the site pays for. Generous enough
 * that a real session never notices.
 */
const MAX_HISTORY_MESSAGES = 40
const MAX_HISTORY_BYTES = 256 * 1024

/**
 * The conversation the client sends back, kept to the shape the provider can map.
 *
 * It is the user's own browser, and a fabricated tool result buys nothing — the
 * tools enforce the boundary, not the transcript — but a malformed part would
 * otherwise reach the provider and come back as an unexplained 502.
 */
function asHistory(value: unknown): ProviderMessage[] {
  if (!Array.isArray(value)) return []
  const messages: ProviderMessage[] = []
  for (const entry of value) {
    const message = entry as Partial<ProviderMessage>
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    if (!Array.isArray(message.parts)) continue
    const parts = message.parts.filter((part) =>
      PART_KINDS.has((part as { kind?: string })?.kind ?? ''),
    )
    if (parts.length > 0) messages.push({ role: message.role, parts })
  }
  // The transcript comes from the client and is billed on every turn, so its
  // size is not the client's to decide. The newest turns are the ones that
  // matter to the answer, so a long conversation loses its oldest.
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES)
  let budget = MAX_HISTORY_BYTES
  const kept: ProviderMessage[] = []
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const message = trimmed[i] as ProviderMessage
    budget -= JSON.stringify(message.parts).length
    if (budget < 0) break
    kept.unshift(message)
  }
  return kept
}

export interface AssistantConfig {
  /** The model. Absent configuration means the feature does not exist. */
  provider: AssistantProvider
  /** Also serve the same tools over MCP, for Claude Code and Claude Desktop. */
  mcp?: boolean
  /** Model calls per message before the loop gives up. */
  maxTurns?: number
}

export interface AssistantHostOptions {
  config: AssistantConfig
  db: Db
  /** Reading, validating and applying schema proposals; absent with no schema directory. */
  schema?: SchemaProposalPort
  siteName: string
  version: string
  /** Sends a request through the Management API, as the signed-in caller. */
  dispatch: (request: Request) => Promise<Response>
}

/** The public shape of a change, which never includes the prepared request body. */
const toJson = (change: ProposedChange) => ({
  key: change.key,
  kind: change.kind,
  summary: change.summary,
  status: change.status,
  problems: change.problems,
  error: change.error,
  effect: effectOf(change.kind),
  createDate: change.createDate,
})

const changesetJson = (changeset: Changeset) => ({
  key: changeset.key,
  title: changeset.title,
  origin: changeset.origin,
  createDate: changeset.createDate,
  updateDate: changeset.updateDate,
  changes: changeset.changes.map(toJson),
})

export interface AssistantHost {
  /** Handles a request under the assistant's path, or undefined when it is not one. */
  handle(request: Request, pathname: string, principal: Principal): Promise<Response | undefined>
  /**
   * Whether the model is usable, for the boot log and the drawer. `deep` asks
   * Bedrock itself rather than only resolving credentials.
   */
  status(deep?: boolean): Promise<ProviderStatus>
  store: ChangesetStore
}

/**
 * A provider that cannot check itself is taken at its word; only one that says it
 * is broken is reported as broken. The alternative — calling the model to find
 * out — costs tokens on every boot and every time the drawer opens.
 */
const UNCHECKED: ProviderStatus = { ok: true, detail: 'ready' }

export function createAssistantHost(options: AssistantHostOptions): AssistantHost {
  const store = createChangesetStore(options.db)
  const paths = new Map(
    listOperations(loadSpec()).map((operation) => [operation.operationId, operation.path]),
  )
  const pathOf = (operationId: string) => paths.get(operationId)

  /**
   * One Management API call as the caller. The user's cookies are forwarded
   * rather than a privileged token minted, so the assistant cannot outrun the
   * permissions of the person it is helping.
   */
  const callFor = (source: Request): ManagementCall => {
    const origin = new URL(source.url).origin
    const cookie = source.headers.get('cookie')
    const authorization = source.headers.get('authorization')
    return async ({ method, path, query, body }) => {
      const url = new URL(path, origin)
      for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value)
      const headers = new Headers({ accept: 'application/json' })
      if (cookie) headers.set('cookie', cookie)
      if (authorization) headers.set('authorization', authorization)
      if (body !== undefined) headers.set('content-type', 'application/json')
      const response = await options.dispatch(
        new Request(url, {
          method: method.toUpperCase(),
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const text = await response.text()
      let parsed: unknown = text === '' ? null : text
      if (text !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          // A non-JSON body is passed through as text; the tools report it as-is.
        }
      }
      return { status: response.status, body: parsed }
    }
  }

  const toolsFor = (request: Request, changeset: () => Promise<string>) =>
    createToolHost({
      call: callFor(request),
      changesets: store,
      changeset,
      schema: options.schema,
    })

  /**
   * Whether this caller may change types. A dispatched operation would have gone
   * through `authorization.ts`; a schema proposal writes a file instead, so the
   * same question is asked here — Settings, as that file requires for every
   * `document-type` operation.
   */
  const maySetSchema = (principal: Principal): boolean => hasSection(principal, 'settings')

  /**
   * One changeset per MCP run: the newest with something still awaiting review is
   * reused, so an agent's proposals arrive as one group, and a fresh one starts
   * once the last has been dealt with.
   */
  const mcpChangeset = async (userKey: string): Promise<string> => {
    const open = await store.openFor(userKey, 'mcp')
    if (open) return open.key
    const created = await store.create({ userKey, title: 'Proposed over MCP', origin: 'mcp' })
    return created.key
  }

  const chat = async (request: Request, principal: Principal): Promise<Response> => {
    const body = (await request.json().catch(() => ({}))) as {
      message?: unknown
      changesetKey?: unknown
      viewing?: unknown
      history?: unknown
    }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (message === '') return Response.json({ error: 'A message is required.' }, { status: 400 })

    const existing =
      typeof body.changesetKey === 'string' ? await store.load(body.changesetKey) : undefined
    const changeset =
      existing && existing.userKey === principal.id
        ? existing
        : await store.create({
            userKey: principal.id,
            title: message.slice(0, 120),
            origin: 'backoffice',
          })

    const history = asHistory(body.history)
    const tools = toolsFor(request, async () => changeset.key)

    try {
      const run = await runConversation({
        provider: options.config.provider,
        tools,
        maxTurns: options.config.maxTurns,
        system: systemPrompt({
          siteName: options.siteName,
          userName: principal.name,
          viewing: typeof body.viewing === 'string' ? body.viewing : undefined,
        }),
        messages: [...history, { role: 'user', parts: [{ kind: 'text', text: message }] }],
      })
      const settled = await store.load(changeset.key)
      return Response.json({
        changesetKey: changeset.key,
        text: run.text,
        exhausted: run.exhausted,
        history: run.messages,
        changes: (settled?.changes ?? []).map(toJson),
      })
    } catch (error) {
      log.error('The assistant could not answer: {message}', {
        message: (error as Error).message,
      })
      // The model being unreachable is not a CMS fault: report it and leave
      // everything else working.
      return Response.json(
        { changesetKey: changeset.key, error: (error as Error).message },
        { status: 502 },
      )
    }
  }

  /** A change of the caller's own, so knowing a key is not enough to approve one. */
  const findChange = (principal: Principal, changeKey: string) =>
    store.changeFor(principal.id, changeKey)

  const settleChange = async (
    request: Request,
    principal: Principal,
    changeKey: string,
    action: 'approve' | 'discard',
  ): Promise<Response> => {
    const change = await findChange(principal, changeKey)
    if (!change) return new Response('Not Found', { status: 404 })

    if (action === 'discard') {
      await store.settle(changeKey, { status: 'discarded' })
      return Response.json({ key: changeKey, status: 'discarded' })
    }

    const outcome = await applyChange(change, {
      call: callFor(request),
      changesets: store,
      schema: options.schema,
      maySetSchema: maySetSchema(principal),
    })
    log.info('{user} {verb} assistant change {key} ({kind})', {
      user: principal.userName,
      verb: outcome.applied ? 'applied' : 'could not apply',
      key: changeKey,
      kind: change.kind,
    })
    return Response.json(
      {
        key: changeKey,
        status: outcome.applied ? 'applied' : 'failed',
        error: outcome.error,
      },
      { status: outcome.applied ? 200 : 409 },
    )
  }

  /**
   * The last check, so the drawer can open without asking Bedrock every time — a
   * deep check costs a token or two. Boot fills it; a refresh replaces it.
   */
  let cached: ProviderStatus | undefined
  /**
   * When a request last asked for a deep check, which costs a real model call.
   * The boot check does not count: a refresh must work immediately after it.
   */
  let lastRefreshAt = 0
  const REFRESH_INTERVAL_MS = 30_000

  const status = async (deep = false): Promise<ProviderStatus> => {
    const provider = options.config.provider
    if (!provider.check) return UNCHECKED
    if (!deep && cached) return cached
    try {
      const result = await provider.check(deep)
      cached = result
      return result
    } catch (error) {
      // A check that throws is itself a failure to report, not one to propagate.
      const failed = { ok: false, detail: (error as Error).message }
      cached = failed
      return failed
    }
  }

  return {
    store,
    status,

    async handle(request, pathname, principal) {
      if (pathname === '/status' && request.method === 'GET') {
        const privileged = hasSection(principal, 'settings')
        // `?refresh=1` asks Bedrock again, model included; a plain read does not.
        // Only whoever could act on the answer may ask, and no faster than a
        // person would — otherwise it is a paid call any account can repeat.
        const asked = new URL(request.url).searchParams.get('refresh') !== null
        const refresh = asked && privileged && Date.now() - lastRefreshAt > REFRESH_INTERVAL_MS
        if (refresh) lastRefreshAt = Date.now()
        const current = await status(refresh)
        return Response.json({
          ...current,
          // The model id, the region, which profile the credentials came from and
          // when they run out are what whoever can fix the configuration needs.
          // An editor needs to know whether it works.
          ...(privileged
            ? {}
            : {
                detail: current.ok
                  ? 'The assistant is available.'
                  : 'The assistant is unavailable. An administrator can see why.',
                remedy: undefined,
                expires: undefined,
              }),
          // So the drawer does not offer a re-check to somebody it would refuse.
          canRefresh: privileged,
          provider: options.config.provider.name,
          mcp: options.config.mcp === true,
        })
      }

      if (pathname === '/chat' && request.method === 'POST') {
        return await chat(request, principal)
      }

      if (pathname === '/changesets' && request.method === 'GET') {
        const changesets = await store.listFor(principal.id)
        return Response.json(changesets.map(changesetJson))
      }

      // The full proposal, body included, for the pane that shows and edits it.
      // The list deliberately leaves the body out: it is the prepared request and
      // most of the payload.
      const detail = /^\/changes\/([^/]+)$/.exec(pathname)
      if (detail && request.method === 'GET') {
        const change = await findChange(principal, detail[1] as string)
        if (!change) return new Response('Not Found', { status: 404 })
        return Response.json({ ...toJson(change), params: change.params, body: change.body })
      }

      // A person editing what the assistant drafted. Only the body moves; the kind
      // and the path parameters are fixed at proposal time, so this cannot turn a
      // draft save into a different operation, and edited TSX is scanned again.
      const edit = /^\/changes\/([^/]+)$/.exec(pathname)
      if (edit && request.method === 'PUT') {
        const change = await findChange(principal, edit[1] as string)
        if (!change) return new Response('Not Found', { status: 404 })
        if (change.status !== 'proposed') {
          return Response.json(
            { error: `This change is already ${change.status}.` },
            { status: 409 },
          )
        }
        const payload = (await request.json().catch(() => undefined)) as
          | { body?: unknown }
          | undefined
        if (!payload || typeof payload.body !== 'object' || payload.body === null) {
          return Response.json({ error: 'A body object is required.' }, { status: 400 })
        }

        // Only the fields this kind is edited through, merged onto what was
        // proposed. Refused rather than quietly dropped: a silent drop looks like
        // a save and is not one.
        const allowed = EDITABLE_FIELDS[change.kind]
        const sent = payload.body as Record<string, unknown>
        const rejected = Object.keys(sent).filter((field) => !allowed.includes(field))
        if (rejected.length > 0) {
          return Response.json(
            {
              error: `A ${change.kind} proposal is edited through ${allowed.join(', ')}; ${rejected.join(', ')} ${rejected.length === 1 ? 'is' : 'are'} fixed at proposal time.`,
            },
            { status: 400 },
          )
        }

        const body = { ...(change.body as Record<string, unknown>), ...sent }
        const problems = change.kind.startsWith('template')
          ? scanTemplateSource(
              `${String(body.alias ?? 'template')}.tsx`,
              typeof body.content === 'string' ? body.content : '',
            )
          : change.kind.startsWith('document-type') || change.kind.startsWith('data-type')
            ? await (options.schema?.validate(
                change.kind,
                String(body.alias ?? ''),
                String(body.toml ?? ''),
              ) ?? Promise.resolve([]))
            : []
        await store.replaceBody(change.key, body, problems)
        return Response.json({ key: change.key, problems })
      }

      const diff = /^\/changes\/([^/]+)\/diff$/.exec(pathname)
      if (diff && request.method === 'GET') {
        const found = await findChange(principal, diff[1] as string)
        if (!found) return new Response('Not Found', { status: 404 })
        const call = callFor(request)
        const [shown, described] = await Promise.all([
          reviewChange(found, {
            call,
            operationPath: (operationId) => pathOf(operationId),
            schema: options.schema,
          }),
          describeChange(found, { call }),
        ])
        return Response.json({ ...shown, ...described })
      }

      const settle = /^\/changes\/([^/]+)\/(approve|discard)$/.exec(pathname)
      if (settle && request.method === 'POST') {
        return await settleChange(
          request,
          principal,
          settle[1] as string,
          settle[2] as 'approve' | 'discard',
        )
      }

      if (pathname === '/mcp' && options.config.mcp === true) {
        return await handleMcpRequest(request, {
          tools: toolsFor(request, () => mcpChangeset(principal.id)),
          serverName: options.siteName,
          version: options.version,
        })
      }

      return undefined
    },
  }
}
