/**
 * The tools the model is given: two read tools, and one propose tool per change
 * kind. There is no mutating tool, so there is nothing for a prompt-injection
 * payload in page content to reach for.
 *
 * A propose tool builds a complete Management API request and stores it. It never
 * dispatches, so "the assistant changed something" is not a state this code can
 * produce — only an approval, elsewhere, can.
 */
import { type HttpMethod, listOperations, loadSpec, type OperationInfo } from '@bunbraco/contracts'
import type { ChangesetStore, ProposedChange, SchemaProposalPort } from './changeset.ts'
import { scanTemplateSource } from './guardrails.ts'
import { APPLY_OPERATIONS, type ChangeKind, isReadable, readableOperations } from './operations.ts'

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool's input, as every provider wants it. */
  inputSchema: Record<string, unknown>
}

export interface ToolResult {
  ok: boolean
  content: unknown
}

/** One Management API call, made as the signed-in user by the host. */
export type ManagementCall = (input: {
  method: HttpMethod
  path: string
  query?: Readonly<Record<string, string>>
  body?: unknown
}) => Promise<{ status: number; body: unknown }>

export interface ToolHostOptions {
  call: ManagementCall
  changesets: ChangesetStore
  /** Reading and writing schema files; absent on a site with no schema directory. */
  schema?: SchemaProposalPort
  /**
   * The changeset to append to, resolved on first use — an MCP client sends
   * several requests before it proposes anything, and a changeset per handshake
   * would fill the review list with empty ones.
   */
  changeset: () => Promise<string>
  operations?: readonly OperationInfo[]
}

const VALUES = {
  type: 'array',
  description: 'Property values to set. Aliases not listed keep their current value.',
  items: {
    type: 'object',
    properties: {
      alias: { type: 'string' },
      value: { description: 'Any JSON value the property editor accepts.' },
      culture: { type: ['string', 'null'] },
      segment: { type: ['string', 'null'] },
    },
    required: ['alias'],
  },
} as const

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'list_operations',
    description:
      'List the read operations available, with their method and path. Call this to discover what can be queried before calling query.',
    inputSchema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          description:
            'Restrict to one area, e.g. document, document-type, data-type, tree, item, template.',
        },
      },
    },
  },
  {
    name: 'query',
    description:
      'Run a read operation from the management API and return its response. Only read operations are available; there is no way to change anything with this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'An operationId from list_operations.' },
        params: {
          type: 'object',
          description:
            'Path parameters, keyed as the path template names them, e.g. { "id": "…" }.',
          additionalProperties: { type: 'string' },
        },
        query: {
          type: 'object',
          description: 'Query-string parameters, e.g. { "skip": "0", "take": "100" }.',
          additionalProperties: { type: 'string' },
        },
        body: { description: 'Request body, for the few read operations that take one.' },
      },
      required: ['operationId'],
    },
  },
  {
    name: 'propose_document_update',
    description:
      'Propose changes to an existing page. Saved as a draft when the user approves it; you cannot publish.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        summary: {
          type: 'string',
          description: 'One line describing the change, for the reviewer.',
        },
        name: { type: 'string', description: 'A new name for the page, if it should change.' },
        culture: {
          type: ['string', 'null'],
          description: 'The culture a new name applies to, for a culture-variant page.',
        },
        values: VALUES,
      },
      required: ['documentId', 'summary'],
    },
  },
  {
    name: 'propose_document_create',
    description:
      'Propose a new page. Created unpublished when the user approves it. Check the parent type allows this type as a child first.',
    inputSchema: {
      type: 'object',
      properties: {
        documentTypeId: { type: 'string' },
        parentId: {
          type: ['string', 'null'],
          description: 'Omit or null to create at the root, which the type must allow.',
        },
        name: { type: 'string' },
        summary: { type: 'string' },
        templateId: { type: ['string', 'null'] },
        values: VALUES,
      },
      required: ['documentTypeId', 'name', 'summary'],
    },
  },
  {
    name: 'propose_template',
    description:
      'Propose template source. TSX only: import from "bunbraco" or a file beside it, and no Bun, process, fetch, eval or node: imports. Approving this goes live at once, so say what it changes.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: {
          type: ['string', 'null'],
          description: 'The template to change; omit to propose a new one.',
        },
        name: { type: 'string' },
        alias: { type: 'string' },
        content: { type: 'string', description: 'The complete TSX source, not a fragment.' },
        summary: { type: 'string' },
      },
      required: ['name', 'content', 'summary'],
    },
  },
  {
    name: 'propose_document_type',
    description:
      'Propose a document type as the TOML file it is stored in \u2014 the file that gets committed. Write it as it should read: aliases rather than ids, one [[property]] table per property. Call read_schema first for a type that exists and change what it gives you.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'The type\u2019s alias, which names its file.' },
        toml: {
          type: 'string',
          description:
            'The whole file, not a fragment: a [document-type] table with alias and name, then a [[property]] table per property whose `type` is a data type alias such as textstring or textarea.',
        },
        summary: { type: 'string' },
      },
      required: ['alias', 'toml', 'summary'],
    },
  },
  {
    name: 'propose_data_type',
    description:
      'Propose a data type (a configured property editor) as the TOML file it is stored in.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' },
        toml: {
          type: 'string',
          description: 'The whole file: a [data-type] table with alias, name and editor.',
        },
        summary: { type: 'string' },
      },
      required: ['alias', 'toml', 'summary'],
    },
  },
  {
    name: 'read_schema',
    description:
      'The TOML of a document type or data type as it is on disk now, so it can be changed rather than rewritten from nothing. Empty when the type does not exist yet.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['document-type', 'data-type'] },
        alias: { type: 'string' },
      },
      required: ['kind', 'alias'],
    },
  },
]

const ok = (content: unknown): ToolResult => ({ ok: true, content })
const fail = (message: string): ToolResult => ({ ok: false, content: { error: message } })

/** Fills `{id}`-style placeholders; a missing parameter is an error, not an empty segment. */
function fillPath(template: string, params: Readonly<Record<string, string>>): string | undefined {
  let missing = false
  const path = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined || value === '') {
      missing = true
      return ''
    }
    return encodeURIComponent(value)
  })
  return missing ? undefined : path
}

async function hash(value: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

/** What the entity looked like when proposed, so apply can refuse a stale write. */
const baselineOf = (body: unknown): Promise<string> => hash(JSON.stringify(body ?? null))

const str = (input: Record<string, unknown>, name: string): string | undefined => {
  const value = input[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

interface ValueEntry {
  alias: string
  value?: unknown
  culture?: string | null
  segment?: string | null
}

const sameSlot = (a: ValueEntry, b: ValueEntry) =>
  a.alias === b.alias &&
  (a.culture ?? null) === (b.culture ?? null) &&
  (a.segment ?? null) === (b.segment ?? null)

/** Proposed values over the document's current ones, so an unnamed alias is left alone. */
function mergeValues(
  current: readonly ValueEntry[],
  proposed: readonly ValueEntry[],
): ValueEntry[] {
  const merged = current.map((entry) => ({ ...entry }))
  for (const entry of proposed) {
    const at = merged.findIndex((existing) => sameSlot(existing, entry))
    const next = {
      alias: entry.alias,
      value: entry.value,
      culture: entry.culture ?? null,
      segment: entry.segment ?? null,
    }
    if (at === -1) merged.push(next)
    else merged[at] = next
  }
  return merged
}

export function createToolHost(options: ToolHostOptions) {
  const operations = options.operations ?? listOperations(loadSpec())
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]))
  const readable = readableOperations(operations)

  /** A read, refused here rather than relied on to be refused downstream. */
  const read = async (
    operationId: string,
    params: Readonly<Record<string, string>> = {},
    query?: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<{ status: number; body: unknown } | { error: string }> => {
    const operation = byId.get(operationId)
    if (!operation) return { error: `${operationId} is not an operation in the contract` }
    if (!isReadable(operation)) return { error: `${operationId} is not available to the assistant` }
    const path = fillPath(operation.path, params)
    if (path === undefined)
      return { error: `${operationId} needs path parameters: ${operation.path}` }
    return await options.call({ method: operation.method, path, query, body })
  }

  const append = async (
    kind: ChangeKind,
    input: {
      summary: string
      params: Record<string, string>
      body: unknown
      baseline: string | undefined
      problems?: ProposedChange['problems']
    },
  ): Promise<ToolResult> => {
    const change: ProposedChange = {
      key: crypto.randomUUID(),
      kind,
      summary: input.summary,
      params: input.params,
      body: input.body,
      baseline: input.baseline,
      problems: input.problems ?? [],
      status: 'proposed',
      error: undefined,
      createDate: new Date().toISOString(),
    }
    await options.changesets.append(await options.changeset(), change)
    return ok({
      proposed: change.key,
      kind,
      operation: APPLY_OPERATIONS[kind],
      problems: change.problems,
      awaiting:
        change.problems.length > 0
          ? 'This proposal has problems and cannot be approved until they are fixed.'
          : 'Waiting for the user to review and approve it. Nothing has changed yet.',
    })
  }

  const proposeDocumentUpdate = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const id = str(input, 'documentId')
    const summary = str(input, 'summary')
    if (!id || !summary) return fail('documentId and summary are required')

    const current = await read('GetDocumentById', { id })
    if ('error' in current) return fail(current.error)
    if (current.status !== 200) return fail(`could not read document ${id} (${current.status})`)

    const document = current.body as {
      values?: ValueEntry[]
      variants?: { culture?: string | null; segment?: string | null; name?: string }[]
      documentType?: { id?: string }
      template?: { id?: string } | null
    }
    const name = str(input, 'name')
    const culture = typeof input.culture === 'string' ? input.culture : null
    const variants = (document.variants ?? []).map((variant) => ({
      culture: variant.culture ?? null,
      segment: variant.segment ?? null,
      name:
        name !== undefined && (variant.culture ?? null) === culture ? name : (variant.name ?? ''),
    }))

    const values = mergeValues(
      document.values ?? [],
      Array.isArray(input.values) ? (input.values as ValueEntry[]) : [],
    )

    return await append('document', {
      summary,
      params: { id },
      // The template is carried through deliberately: the update handler reads it
      // from the body, so leaving it out would clear the page's template and stop
      // it rendering. A partial proposal still has to be a complete request.
      body: { values, variants, template: document.template ?? null },
      baseline: await baselineOf(current.body),
    })
  }

  const proposeDocumentCreate = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const documentTypeId = str(input, 'documentTypeId')
    const name = str(input, 'name')
    const summary = str(input, 'summary')
    if (!documentTypeId || !name || !summary) {
      return fail('documentTypeId, name and summary are required')
    }
    const parentId = str(input, 'parentId')
    const values = Array.isArray(input.values) ? (input.values as ValueEntry[]) : []

    // Without a template a page has nothing to render with, and the model has no
    // reason to know which one. The backoffice's create dialog preselects the
    // type's default; an omitted template does the same rather than sending null.
    let templateId = str(input, 'templateId')
    if (!templateId) {
      const type = await read('GetDocumentTypeById', { id: documentTypeId })
      if (!('error' in type) && type.status === 200) {
        templateId = (type.body as { defaultTemplate?: { id?: string } | null }).defaultTemplate?.id
      }
    }

    return await append('document-create', {
      summary,
      params: {},
      body: {
        documentType: { id: documentTypeId },
        parent: parentId ? { id: parentId } : null,
        template: templateId ? { id: templateId } : null,
        values: values.map((entry) => ({
          alias: entry.alias,
          value: entry.value,
          culture: entry.culture ?? null,
          segment: entry.segment ?? null,
        })),
        variants: [{ culture: null, segment: null, name }],
      },
      baseline: undefined,
    })
  }

  const proposeTemplate = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const name = str(input, 'name')
    const summary = str(input, 'summary')
    const content = typeof input.content === 'string' ? input.content : undefined
    if (!name || !summary || content === undefined) {
      return fail('name, content and summary are required')
    }
    const templateId = str(input, 'templateId')
    const alias = str(input, 'alias') ?? name.replace(/[^A-Za-z0-9]+/g, '')

    let baseline: string | undefined
    if (templateId) {
      const current = await read('GetTemplateById', { id: templateId })
      if ('error' in current) return fail(current.error)
      if (current.status !== 200) return fail(`could not read template ${templateId}`)
      baseline = await baselineOf((current.body as { content?: string | null }).content ?? null)
    }

    const problems = scanTemplateSource(`${alias}.tsx`, content)
    return await append(templateId ? 'template' : 'template-create', {
      summary,
      params: templateId ? { id: templateId } : {},
      body: { name, alias, content },
      baseline,
      problems,
    })
  }

  /**
   * A schema proposal is the TOML file, validated against the rest of the schema
   * before anyone is asked to approve it, so a reviewer is never shown something
   * that cannot be applied.
   */
  const proposeSchema = async (
    input: Record<string, unknown>,
    base: 'document-type' | 'data-type',
  ): Promise<ToolResult> => {
    const alias = str(input, 'alias')
    const toml = typeof input.toml === 'string' ? input.toml : undefined
    const summary = str(input, 'summary')
    if (!alias || !toml || !summary) return fail('alias, toml and summary are required')
    if (!options.schema) return fail('this site does not manage schema as files')

    const current = await options.schema.read(base, alias)
    const kind = (current === undefined ? `${base}-create` : base) as ChangeKind
    const problems = await options.schema.validate(kind, alias, toml)

    return await append(kind, {
      summary,
      params: {},
      body: { alias, toml, file: options.schema.fileFor(base, alias) },
      // The file as it stands, so an approval refuses if somebody else changed it.
      baseline: current === undefined ? undefined : await baselineOf(current),
      problems,
    })
  }

  const execute = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    switch (name) {
      case 'list_operations': {
        const area = str(input, 'area')
        const list = readable.filter((operation) => !area || operation.area === area)
        return ok(
          list.map((operation) => ({
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
          })),
        )
      }
      case 'query': {
        const operationId = str(input, 'operationId')
        if (!operationId) return fail('operationId is required')
        const result = await read(
          operationId,
          (input.params as Record<string, string>) ?? {},
          (input.query as Record<string, string>) ?? undefined,
          input.body,
        )
        return 'error' in result ? fail(result.error) : ok(result)
      }
      case 'propose_document_update':
        return await proposeDocumentUpdate(input)
      case 'propose_document_create':
        return await proposeDocumentCreate(input)
      case 'propose_template':
        return await proposeTemplate(input)
      case 'read_schema': {
        const kind = str(input, 'kind')
        const alias = str(input, 'alias')
        if (!kind || !alias) return fail('kind and alias are required')
        if (!options.schema) return fail('this site does not manage schema as files')
        const toml = await options.schema.read(kind, alias)
        return ok({
          file: options.schema.fileFor(kind, alias),
          exists: toml !== undefined,
          toml: toml ?? '',
        })
      }
      case 'propose_document_type':
        return await proposeSchema(input, 'document-type')
      case 'propose_data_type':
        return await proposeSchema(input, 'data-type')
      default:
        return fail(`${name} is not a tool the assistant has`)
    }
  }

  return { definitions: TOOL_DEFINITIONS, execute }
}
