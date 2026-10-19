import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { McpPolicy } from "@/mcp/policy"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function clientWith(callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>) {
  return { callTool } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

describe("McpCatalog.call", () => {
  test("retries transport failures when a retry policy is set", async () => {
    let attempts = 0
    const counters = McpPolicy.counters()
    const client = clientWith(async () => {
      attempts += 1
      if (attempts === 1) throw new Error("socket closed")
      return { content: [], isError: false }
    })

    const result = await McpCatalog.call(mcpTool(), client, {}, { retry: { attempts: 2, delay: 0 }, counters })

    expect(result).toEqual({ content: [], isError: false })
    expect(attempts).toBe(2)
    expect(counters).toEqual({
      calls: 1,
      succeeded: 1,
      failed: 0,
      retries: 1,
      rateLimited: 0,
      connects: 0,
      connectFailures: 0,
    })
  })

  test("does not retry tool-level errors", async () => {
    let attempts = 0
    const client = clientWith(async () => {
      attempts += 1
      return { content: [{ type: "text", text: "denied" }], isError: true }
    })

    const error = await McpCatalog.call(mcpTool(), client, {}, { retry: { attempts: 3, delay: 0 } }).catch(
      (error: unknown) => error,
    )

    expect(attempts).toBe(1)
    expect(error).toBeInstanceOf(McpPolicy.ToolError)
    expect((error as Error).message).toBe("denied")
  })

  test("rejects calls over the server rate limit", async () => {
    const counters = McpPolicy.counters()
    const limiter = new McpPolicy.Limiter({ requests: 1, window: 60_000 })
    const client = clientWith(async () => ({ content: [], isError: false }))

    await McpCatalog.call(mcpTool(), client, {}, { limiter, counters })
    const error = await McpCatalog.call(mcpTool(), client, {}, { limiter, counters }).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(McpPolicy.LimitError)
    expect((error as McpPolicy.LimitError).message).toContain("screenshot")
    expect(counters.calls).toBe(1)
    expect(counters.succeeded).toBe(1)
    expect(counters.rateLimited).toBe(1)
  })
})

describe("McpCatalog.permissionRules", () => {
  test("maps tool actions to namespaced rules", () => {
    expect(McpCatalog.permissionRules("ms", { search: "allow", "*": "ask" })).toEqual([
      { permission: "ms_search", pattern: "*", action: "allow" },
      { permission: "ms_*", pattern: "*", action: "ask" },
    ])
  })

  test("expands pattern maps", () => {
    expect(McpCatalog.permissionRules("ms", { search: { "*": "allow", "read_*": "deny" } })).toEqual([
      { permission: "ms_*", pattern: "*", action: "allow" },
      { permission: "ms_read_*", pattern: "*", action: "deny" },
    ])
  })

  test("sanitizes server and tool names while keeping wildcards", () => {
    expect(McpCatalog.permissionRules("my server.v2", { "get.ticket": "allow" })).toEqual([
      { permission: "my_server_v2_get_ticket", pattern: "*", action: "allow" },
    ])
    expect(McpCatalog.permissionRules("srv", { "get/ticket*": "allow" })).toEqual([
      { permission: "srv_get_ticket*", pattern: "*", action: "allow" },
    ])
  })

  test("returns no rules without permission config", () => {
    expect(McpCatalog.permissionRules("ms")).toEqual([])
  })
})

describe("McpCatalog.selectionRules", () => {
  test("maps agent selection to allow and deny rules", () => {
    expect(McpCatalog.selectionRules({ github: true, slack: false })).toEqual([
      { permission: "github_*", pattern: "*", action: "allow" },
      { permission: "slack_*", pattern: "*", action: "deny" },
    ])
  })
})
