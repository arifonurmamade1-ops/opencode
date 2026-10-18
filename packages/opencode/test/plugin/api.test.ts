import { describe, expect, test } from "bun:test"
import { tool } from "@opencode-ai/plugin"
import { PluginApi } from "../../src/plugin/api"

function record(overrides: Partial<PluginApi.PluginRecord> = {}): PluginApi.PluginRecord {
  return {
    id: "demo",
    spec: "demo",
    source: "npm",
    api: PluginApi.API_VERSION,
    status: "loaded",
    capabilities: [],
    hooks: [],
    tools: [],
    ...overrides,
  }
}

describe("PluginApi.describe", () => {
  test("detects tool contributions", () => {
    const description = PluginApi.describe({
      tool: {
        zeta: tool({ description: "z", args: {}, execute: async () => "" }),
        alpha: tool({ description: "a", args: {}, execute: async () => "" }),
      },
    })
    expect(description.capabilities).toEqual(["tools"])
    expect(description.tools).toEqual(["alpha", "zeta"])
    expect(description.hooks).toEqual([])
  })

  test("detects provider, config, and hook contributions", () => {
    const description = PluginApi.describe({
      auth: { provider: "p", methods: [] },
      config: async () => {},
      event: async () => {},
      "tool.execute.before": async () => {},
    })
    expect(description.capabilities).toEqual(["providers", "hooks", "config"])
    expect(description.hooks).toEqual(["config", "event", "tool.execute.before"])
    expect(description.tools).toEqual([])
  })

  test("merges several hook objects without duplicates", () => {
    const description = PluginApi.describe([
      { tool: { alpha: tool({ description: "a", args: {}, execute: async () => "" }) } },
      {
        tool: { beta: tool({ description: "b", args: {}, execute: async () => "" }) },
        event: async () => {},
      },
      { event: async () => {} },
    ])
    expect(description.capabilities).toEqual(["tools", "hooks"])
    expect(description.tools).toEqual(["alpha", "beta"])
    expect(description.hooks).toEqual(["event"])
  })

  test("reports nothing for empty hooks", () => {
    expect(PluginApi.describe({})).toEqual({ capabilities: [], hooks: [], tools: [] })
  })

  test("recognizes lifecycle trigger hooks", () => {
    const description = PluginApi.describe({
      "model.before": async () => {},
      "model.after": async () => {},
      "commit.before": async () => {},
      "commit.after": async () => {},
    })
    expect(description.capabilities).toEqual(["hooks"])
    expect(description.hooks).toEqual(["commit.after", "commit.before", "model.after", "model.before"])
  })
})

describe("PluginApi.validate", () => {
  test("accepts a well-formed hooks object", () => {
    const problems = PluginApi.validate({
      tool: { alpha: tool({ description: "a", args: {}, execute: async () => "" }) },
      auth: { provider: "p", methods: [{ type: "api", label: "API key" }] },
      provider: { id: "p" },
      config: async () => {},
      event: async () => {},
      dispose: async () => {},
      "tool.execute.before": async () => {},
    })
    expect(problems).toEqual([])
  })

  test("rejects values that are not hooks objects", () => {
    expect(PluginApi.validate(undefined)).toEqual(["it must return a hooks object"])
    expect(PluginApi.validate("hooks")).toEqual(["it must return a hooks object"])
    expect(PluginApi.validate([])).toEqual(["it must return a hooks object"])
  })

  test("rejects non-function known hooks", () => {
    expect(PluginApi.validate({ "tool.execute.after": 1 })).toEqual(['"tool.execute.after" must be a function'])
    expect(PluginApi.validate({ dispose: "later" })).toEqual(['"dispose" must be a function'])
    expect(PluginApi.validate({ config: {} })).toEqual(['"config" must be a function'])
    expect(PluginApi.validate({ "commit.before": "run" })).toEqual(['"commit.before" must be a function'])
  })

  test("accepts the lifecycle trigger hooks", () => {
    expect(
      PluginApi.validate({
        "model.before": async () => {},
        "model.after": async () => {},
        "commit.before": async () => {},
        "commit.after": async () => {},
      }),
    ).toEqual([])
  })

  test("rejects malformed tool definitions", () => {
    expect(PluginApi.validate({ tool: "nope" })).toEqual(['"tool" must be an object of tool definitions'])
    expect(PluginApi.validate({ tool: { foo: null } })).toEqual(['tool "foo" must be an object'])
    expect(PluginApi.validate({ tool: { foo: { description: 1, execute: "x" } } })).toEqual([
      'tool "foo" must have a string "description"',
      'tool "foo" must have an "args" object',
      'tool "foo" must have an "execute" function',
    ])
  })

  test("rejects malformed auth and provider hooks", () => {
    expect(PluginApi.validate({ auth: {} })).toEqual([
      '"auth" must have a string "provider"',
      '"auth" must have a "methods" array',
    ])
    expect(PluginApi.validate({ provider: {} })).toEqual(['"provider" must have a string "id"'])
    expect(PluginApi.validate({ auth: "key" })).toEqual(['"auth" must be an object'])
  })

  test("ignores unknown keys for forward compatibility", () => {
    expect(PluginApi.validate({ future_hook: () => {}, anything: 1 })).toEqual([])
  })
})

describe("PluginApi.apiVersionProblem", () => {
  test("accepts plugins without a declared version and the current version", () => {
    expect(PluginApi.apiVersionProblem(undefined)).toBeUndefined()
    expect(PluginApi.apiVersionProblem(PluginApi.API_VERSION)).toBeUndefined()
  })

  test("reports plugins that require a newer plugin API", () => {
    const problem = PluginApi.apiVersionProblem(PluginApi.API_VERSION + 1)
    expect(problem).toContain("requires plugin API")
    expect(problem).toContain(`v${PluginApi.API_VERSION + 1}`)
  })

  test("reports invalid versions", () => {
    for (const value of [0, -1, 1.5, Number.NaN])
      expect(PluginApi.apiVersionProblem(value)).toContain("invalid plugin API version")
  })
})

describe("PluginApi.format", () => {
  test("explains when no plugins are known", () => {
    const output = PluginApi.format([])
    expect(output).toContain("No plugins are known")
    expect(output).toContain(`plugin API v${PluginApi.API_VERSION}`)
  })

  test("summarizes statuses and capabilities", () => {
    const output = PluginApi.format([
      record({ id: "active", tools: ["mytool"], hooks: ["event"], capabilities: ["tools", "hooks"] }),
      record({
        id: "old",
        status: "skipped",
        error: `requires plugin API v${PluginApi.API_VERSION + 1}`,
      }),
      record({ id: "broken", source: "file", status: "failed", error: "Failed to load plugin broken: boom" }),
    ])
    expect(output).toContain("3 plugin(s) known: 1 loaded, 1 skipped, 1 failed")
    expect(output).toContain("- active (npm,")
    expect(output).toContain("[loaded] tools: mytool; hooks: event")
    expect(output).toContain("[skipped] requires plugin API")
    expect(output).toContain("[failed] Failed to load plugin broken: boom")
  })

  test("marks loaded plugins without extension points", () => {
    expect(PluginApi.format([record({ id: "quiet" })])).toContain("[loaded] no extension points")
  })

  test("lists plugins sorted by id", () => {
    const output = PluginApi.format([record({ id: "zeta" }), record({ id: "alpha" })])
    expect(output.indexOf("- alpha")).toBeLessThan(output.indexOf("- zeta"))
  })
})
