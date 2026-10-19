import path from "node:path"
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { McpCatalog } from "../../src/mcp/catalog"
import { McpPolicy } from "../../src/mcp/policy"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const policyFixture = path.join(import.meta.dir, "../fixture/mcp-policy-stdio.ts")

function probe(entry: { def: { description?: string } } | undefined) {
  return JSON.parse(entry?.def.description ?? "{}") as { cwd: string; leaked: string | null; configured: string | null }
}

it.instance("sandboxed local servers lose the inherited environment", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    process.env.MCP_POLICY_SECRET = "leaked"
    yield* mcp.add("sandboxed", {
      type: "local",
      command: [process.execPath, policyFixture],
      sandbox: true,
      environment: { MCP_POLICY_CONFIGURED: "yes" },
    })

    expect(probe((yield* mcp.tools()).sandboxed_environment)).toMatchObject({
      leaked: null,
      configured: "yes",
    })
  }),
  60_000,
)

it.instance("local servers inherit the environment by default", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    process.env.MCP_POLICY_SECRET = "leaked"
    yield* mcp.add("open", { type: "local", command: [process.execPath, policyFixture] })

    expect(probe((yield* mcp.tools()).open_environment)).toMatchObject({ leaked: "leaked" })
  }),
  60_000,
)

it.instance("sandboxed local servers stay inside the workspace", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const test = yield* TestInstance
    yield* mcp.add("kept", { type: "local", command: [process.execPath, policyFixture], sandbox: true })

    expect(probe((yield* mcp.tools()).kept_environment).cwd).toBe(test.directory)
  }),
  60_000,
)

it.instance("sandboxed local servers cannot leave the workspace", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("escape", {
      type: "local",
      command: [process.execPath, policyFixture],
      cwd: path.join("..", "outside"),
      sandbox: true,
    })

    const status = (yield* mcp.status()).escape
    expect(status?.status).toBe("failed")
    if (status?.status === "failed") expect(status.error).toContain("inside the workspace")
    expect((yield* mcp.tools()).escape_environment).toBeUndefined()
  }),
  60_000,
)

it.instance("local servers retry connecting when configured", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const test = yield* TestInstance
    const marker = path.join(test.directory, "retry-marker")
    yield* mcp.add("retrying", {
      type: "local",
      command: [process.execPath, policyFixture],
      environment: { MCP_POLICY_RETRY_MARKER: marker },
      retry: { attempts: 2, delay: 1 },
      timeout: 30_000,
    })

    expect((yield* mcp.status()).retrying?.status).toBe("connected")
    expect((yield* mcp.tools()).retrying_environment).toBeDefined()
    expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(true)
    expect((yield* mcp.stats()).retrying?.connects).toBe(1)
  }),
  60_000,
)

it.instance("local servers do not retry without a retry policy", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const test = yield* TestInstance
    const marker = path.join(test.directory, "no-retry-marker")
    yield* mcp.add("once", {
      type: "local",
      command: [process.execPath, policyFixture],
      environment: { MCP_POLICY_RETRY_MARKER: marker },
      timeout: 30_000,
    })

    expect((yield* mcp.status()).once?.status).toBe("failed")
    expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(true)
    expect((yield* mcp.stats()).once?.connectFailures).toBe(1)
  }),
  60_000,
)

it.instance("rate limits reject tool calls over the window", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("limited", {
      type: "local",
      command: [process.execPath, policyFixture],
      rateLimit: { requests: 1, window: 60_000 },
    })

    const entry = (yield* mcp.tools()).limited_count
    expect(entry).toBeDefined()
    const tool = McpCatalog.convertTool(entry!.def, entry!.client, entry!.timeout, entry!.policy)
    const options = { toolCallId: "call_1", abortSignal: new AbortController().signal } as any
    const invoke = () => Promise.resolve(tool.execute!({}, options))

    const first = (yield* Effect.promise(invoke)) as { content: Array<{ type: string; text?: string }> }
    expect(first.content[0]).toMatchObject({ type: "text", text: "1" })

    const error = yield* Effect.promise(() =>
      invoke().then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
    expect(error).toBeInstanceOf(McpPolicy.LimitError)

    const stats = (yield* mcp.stats()).limited
    expect(stats?.calls).toBe(1)
    expect(stats?.succeeded).toBe(1)
    expect(stats?.rateLimited).toBe(1)
    expect(stats?.rateLimit).toEqual({ requests: 1, window: 60_000, used: 1 })
  }),
  60_000,
)

it.instance("server permission and trust settings reach the tool entries", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("guarded", {
      type: "local",
      command: [process.execPath, policyFixture],
      trusted: true,
      permission: { count: "deny", "*": "ask" },
    })

    const entry = (yield* mcp.tools()).guarded_count
    expect(entry?.trusted).toBe(true)
    expect(entry?.rules).toEqual([
      { permission: "guarded_count", pattern: "*", action: "deny" },
      { permission: "guarded_*", pattern: "*", action: "ask" },
    ])
  }),
  60_000,
)
