import { describe, expect, test } from "bun:test"
import type { Config, LspStatus, McpStatus, Provider } from "@opencode-ai/sdk/v2"
import { build, render, summary } from "../src/doctor"

const model: Provider["models"][string] = {
  id: "test-model",
  providerID: "test",
  api: { id: "test-model", url: "http://127.0.0.1:1", npm: "@ai-sdk/openai-compatible" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 10_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
}

const provider: Provider = {
  id: "test",
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: {
    "test-model": model,
  },
}

const config: Config = {
  model: "test/test-model",
  provider: {
    test: {
      name: "Test",
      options: {},
      models: {},
    },
  },
}

function input(overrides: Partial<Parameters<typeof build>[0]> = {}): Parameters<typeof build>[0] {
  return {
    connection: "complete",
    config,
    providers: [provider],
    connected: ["test"],
    mcp: {},
    lsp: [],
    vcs: { branch: "dev" },
    model: { providerID: "test", modelID: "test-model" },
    version: "0.0.0-test",
    ...overrides,
  }
}

describe("tui doctor", () => {
  test("reports every diagnostic category", () => {
    const checks = build(input())
    expect(checks.map((check) => check.id)).toEqual([
      "config",
      "providers",
      "models",
      "apis",
      "mcp",
      "browser",
      "lsp",
      "git",
      "permissions",
      "sandbox",
      "storage",
      "dependencies",
    ])
  })

  test("does not report failures while the session is loading", () => {
    const checks = build(input({ connection: "loading", providers: [], connected: [], model: undefined }))
    expect(checks).toHaveLength(12)
    expect(checks.filter((check) => check.status === "fail")).toHaveLength(0)
    expect(checks[0].status).toBe("warn")
    expect(checks.slice(1).every((check) => check.status === "skip")).toBe(true)
  })

  test("healthy session has no failures", () => {
    const checks = build(
      input({
        mcp: { local: { status: "connected" } },
        lsp: [{ id: "typescript", name: "TypeScript", root: "/repo", status: "connected" }],
      }),
    )
    expect(checks.filter((check) => check.status === "fail")).toHaveLength(0)
    expect(checks).toHaveLength(12)
    expect(summary(checks)).toContain("0 failures")
  })

  test("surfaces provider, model, MCP, and LSP failures", () => {
    const failedMcp: McpStatus = { status: "failed", error: "spawn failed" }
    const failedLsp: LspStatus = { id: "ts", name: "TypeScript", root: "/repo", status: "error" }
    const checks = build(
      input({
        connected: [],
        providers: [],
        model: undefined,
        mcp: { local: failedMcp },
        lsp: [failedLsp],
      }),
    )
    const failed = checks.filter((check) => check.status === "fail").map((check) => check.id)
    expect(failed).toContain("providers")
    expect(failed).toContain("models")
    expect(failed).toContain("mcp")
    expect(failed).toContain("lsp")
    for (const check of checks.filter((item) => item.status !== "ok")) {
      expect(check.nextAction).toBeTruthy()
    }
    expect(render(checks)).toContain("next:")
  })

  test("warns about broad permissions", () => {
    const checks = build(input({ config: { ...config, permission: { edit: "allow", bash: "allow" } } }))
    const permissions = checks.find((check) => check.id === "permissions")
    expect(permissions?.status).toBe("warn")
    expect(permissions?.nextAction).toContain("permission")
  })
})
