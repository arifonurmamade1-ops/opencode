import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type CallToolResult,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Effect } from "effect"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { McpPolicy } from "./policy"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page = await list(cursor)
    result.push(...items(page))
    if (page.nextCursor === undefined) return result
    if (cursors.has(page.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${page.nextCursor}`)
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

export function defs(client: Client, timeout?: number) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT).pipe(Effect.catch(() => Effect.void))
}

export type CallOptions = {
  timeout?: number
  signal?: AbortSignal
  retry?: McpPolicy.RetryPolicy
  limiter?: McpPolicy.Limiter
  counters?: McpPolicy.Counters
  onRetry?: (event: McpPolicy.RetryEvent) => void
}

/**
 * Transport call for one MCP tool with the server's access policy applied:
 * rate limiting, retry, timeout, and counters for observability.
 */
export async function call(
  mcpTool: MCPToolDef,
  client: Client,
  args: unknown,
  options: CallOptions = {},
): Promise<CallToolResult> {
  if (options.limiter) {
    const claim = options.limiter.take()
    if (!claim.ok) {
      if (options.counters) options.counters.rateLimited += 1
      throw new McpPolicy.LimitError(claim.retryAfterMs, `MCP rate limit exceeded for tool "${mcpTool.name}"`)
    }
  }
  if (options.counters) options.counters.calls += 1

  return McpPolicy.withRetry(
    async () => {
      const result = await client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal: options.signal,
          timeout: options.timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
      if (result.isError) {
        throw new McpPolicy.ToolError(
          result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      }
      return result
    },
    options.retry ?? McpPolicy.retryPolicy(),
    {
      onRetry: (event) => {
        if (options.counters) options.counters.retries += 1
        options.onRetry?.(event)
      },
    },
  ).then(
    (result) => {
      if (options.counters) options.counters.succeeded += 1
      return result
    },
    (error) => {
      if (options.counters) options.counters.failed += 1
      throw error
    },
  )
}

/**
 * Translate per-server permission config into tool-keyed permission rules.
 * Rule permissions use the same `<server>_<tool>` names `toolName` produces,
 * so they compose with the regular permission settings.
 */
export function permissionRules(server: string, permission?: ConfigPermissionV1.Info): PermissionV1.Ruleset {
  const prefix = sanitize(server)
  const rules: PermissionV1.Rule[] = []
  for (const [tool, value] of Object.entries(permission ?? {})) {
    if (typeof value === "string") {
      rules.push({ permission: ruleName(prefix, tool), pattern: "*", action: value })
      continue
    }
    rules.push(
      ...Object.entries(value).map(([pattern, action]) => ({
        permission: ruleName(prefix, pattern),
        pattern: "*",
        action,
      })),
    )
  }
  return rules
}

/** Translate an agent's `mcp` server selection into permission rules. */
export function selectionRules(selection: Record<string, boolean>): PermissionV1.Ruleset {
  return Object.entries(selection).map(([server, enabled]) => ({
    permission: sanitize(server) + "_*",
    pattern: "*",
    action: enabled ? "allow" : "deny",
  }))
}

function ruleName(prefix: string, tool: string) {
  // Wildcards in tool keys must survive so `get_*` still matches `get_issue`.
  if (tool === "*") return prefix + "_*"
  return prefix + "_" + tool.replace(/[^a-zA-Z0-9_\-*?]/g, "_")
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number, options: CallOptions = {}): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, execOptions) => {
      const result = await call(mcpTool, client, args, { ...options, timeout, signal: execOptions.abortSignal })
      if (result.content.length > 0 || result.structuredContent === undefined || result.structuredContent === null)
        return result
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      }
    },
  })
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return paginate(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts,
  )
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources,
  )
}

export function resourceTemplates(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resourceTemplates,
  )
}

function listTools(client: Client, timeout: number) {
  return Effect.tryPromise({
    try: () =>
      paginate(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, { timeout })
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, { timeout })
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

export * as McpCatalog from "./catalog"
