/**
 * The same tools over MCP, so Claude Code and Claude Desktop drive the CMS
 * through the identical definitions, the identical authorization and the
 * identical proposal model.
 *
 * MCP clients get query and propose. They do not get apply: approval happens in
 * the backoffice, by a person looking at a diff. An agent that could approve its
 * own changeset would defeat the point of having one.
 *
 * JSON-RPC 2.0 over a single POST, which is the subset of the streamable HTTP
 * transport a stateless server needs — no session, no server-initiated messages,
 * so nothing here holds a connection open.
 */
import type { ConversationTools } from './loop.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpOptions {
  tools: ConversationTools
  serverName?: string
  version?: string
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const result = (id: string | number | null, value: unknown) =>
  Response.json({ jsonrpc: '2.0', id, result: value })

const failure = (id: string | number | null, code: number, message: string) =>
  Response.json({ jsonrpc: '2.0', id, error: { code, message } })

export async function handleMcpRequest(request: Request, options: McpOptions): Promise<Response> {
  if (request.method !== 'POST') {
    return failure(null, -32600, 'The MCP endpoint takes POST requests.')
  }

  let message: JsonRpcRequest
  try {
    message = (await request.json()) as JsonRpcRequest
  } catch {
    return failure(null, -32700, 'The request body is not JSON.')
  }

  const id = message.id ?? null
  const method = message.method ?? ''

  // A notification has no id and takes no response; `initialized` is the one
  // every client sends after handshaking.
  if (message.id === undefined) return new Response(null, { status: 202 })

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: options.serverName ?? 'bunbraco',
          version: options.version ?? '0.0.0',
        },
        instructions:
          'Read the CMS with query, and propose changes with the propose tools. Proposals do nothing until a person approves them in the backoffice, and there is no way to publish.',
      })

    case 'ping':
      return result(id, {})

    case 'tools/list':
      return result(id, {
        tools: options.tools.definitions.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })

    case 'tools/call': {
      const name = typeof message.params?.name === 'string' ? message.params.name : ''
      if (name === '') return failure(id, -32602, 'tools/call needs a tool name.')
      const args = (message.params?.arguments as Record<string, unknown>) ?? {}
      const outcome = await options.tools
        .execute(name, args)
        .catch((error: Error) => ({ ok: false, content: { error: error.message } }))
      return result(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.content, null, 2) }],
        isError: !outcome.ok,
      })
    }

    default:
      return failure(id, -32601, `${method} is not a method this server implements.`)
  }
}
