import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { Hook } from "../../src/hook/hook"
import { HooksPlugin, execute } from "../../src/hook/plugin"

// Self-contained temp dirs: the hook system is plain async code, so these
// tests stay independent from app fixtures and preload state.
async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-hook-"))
  return {
    path: dir,
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  }
}

describe("Hook.normalize", () => {
  test("returns nothing for missing config", () => {
    expect(Hook.normalize(undefined)).toEqual({ hooks: {}, problems: [] })
    expect(Hook.normalize(null)).toEqual({ hooks: {}, problems: [] })
  })

  test("accepts command strings, arrays, and objects", () => {
    const result = Hook.normalize({
      before_tool: "echo a",
      after_tool: ["echo b", { command: "echo c", timeout: 5000 }],
    })
    expect(result.problems).toEqual([])
    expect(result.hooks.before_tool).toEqual([{ command: "echo a", timeout: Hook.DEFAULT_TIMEOUT }])
    expect(result.hooks.after_tool).toEqual([
      { command: "echo b", timeout: Hook.DEFAULT_TIMEOUT },
      { command: "echo c", timeout: 5000 },
    ])
  })

  test("trims commands and drops empty ones", () => {
    const result = Hook.normalize({ on_stop: "  echo a  " })
    expect(result.hooks.on_stop).toEqual([{ command: "echo a", timeout: Hook.DEFAULT_TIMEOUT }])
    expect(result.problems).toEqual([])
  })

  test("reports unknown stages", () => {
    const result = Hook.normalize({ before_toool: "echo a" })
    expect(result.hooks).toEqual({})
    expect(result.problems.length).toBe(1)
    expect(result.problems[0]).toContain('unknown hook stage "before_toool"')
    expect(result.problems[0]).toContain("before_tool")
  })

  test("reports invalid entries and keeps valid ones", () => {
    const result = Hook.normalize({ before_edit: ["", 42, { command: "  " }, "echo ok"] })
    expect(result.hooks.before_edit).toEqual([{ command: "echo ok", timeout: Hook.DEFAULT_TIMEOUT }])
    expect(result.problems).toEqual([
      '"before_edit[0]" is an empty command',
      '"before_edit[1]" must be a command string or an object with a "command"',
      '"before_edit[2].command" must be a non-empty string',
    ])
  })

  test("falls back to the default timeout for invalid timeouts", () => {
    const result = Hook.normalize({ on_error: { command: "echo a", timeout: -5 } })
    expect(result.hooks.on_error).toEqual([{ command: "echo a", timeout: Hook.DEFAULT_TIMEOUT }])
    expect(result.problems).toEqual([
      `"on_error.timeout" must be a number of milliseconds >= 100; using the default`,
    ])
  })

  test("rejects non-object hooks", () => {
    expect(Hook.normalize("echo a").problems).toEqual(["hooks must be an object of stage -> command(s)"])
  })
})

describe("Hook.merge", () => {
  test("returns nothing when both sides are missing", () => {
    expect(Hook.merge(undefined, undefined)).toBeUndefined()
  })

  test("concatenates global and project hooks per stage", () => {
    expect(Hook.merge({ before_tool: ["a"] }, { before_tool: ["b", "a"] })).toEqual({
      before_tool: ["a", "b"],
    })
  })

  test("unions stages and canonicalizes strings", () => {
    expect(Hook.merge({ before_tool: "a" }, { on_stop: ["b"] })).toEqual({
      before_tool: ["a"],
      on_stop: ["b"],
    })
  })

  test("keeps malformed values for normalize to report", () => {
    expect(Hook.merge({ before_tool: ["a"] }, "echo a")).toBeUndefined()
    expect(Hook.merge(undefined, "echo a")).toBeUndefined()
  })
})

describe("Hook.environment", () => {
  test("includes the stage and directory", () => {
    expect(Hook.environment({ stage: "before_tool", directory: "/tmp/project" })).toEqual({
      OPENCODE_HOOK: "before_tool",
      OPENCODE_HOOK_DIRECTORY: "/tmp/project",
    })
  })

  test("adds session and tool when known", () => {
    expect(Hook.environment({ stage: "after_tool", directory: "/tmp", sessionID: "ses_1", tool: "edit" })).toEqual({
      OPENCODE_HOOK: "after_tool",
      OPENCODE_HOOK_DIRECTORY: "/tmp",
      OPENCODE_HOOK_SESSION: "ses_1",
      OPENCODE_HOOK_TOOL: "edit",
    })
  })
})

describe("Hook.payload", () => {
  test("truncates very long strings", () => {
    const parsed = JSON.parse(Hook.payload({ hook: "before_tool", output: "x".repeat(Hook.MAX_STRING + 100) }))
    expect(parsed.hook).toBe("before_tool")
    expect(parsed.output.length).toBeLessThan(Hook.MAX_STRING + 100)
    expect(parsed.output).toContain(`(${Hook.MAX_STRING + 100} chars truncated)`)
  })
})

describe("Hook.format", () => {
  test("explains when nothing is configured", () => {
    expect(Hook.format({})).toContain("No lifecycle hooks are configured")
  })

  test("lists stages with command details", () => {
    const output = Hook.format({
      before_tool: [{ command: "echo a", timeout: Hook.DEFAULT_TIMEOUT }],
      on_stop: [{ command: "notify.sh", timeout: 5_000 }],
    })
    expect(output).toContain("2 stage(s), 2 command(s)")
    expect(output).toContain("  - echo a")
    expect(output).toContain("  - notify.sh (timeout 5s)")
  })

  test("appends problems", () => {
    expect(Hook.format({}, ["broken"])).toContain("  - broken")
  })
})

describe("Hook.isStage", () => {
  test("knows the configured stages", () => {
    expect(Hook.isStage("before_task")).toBe(true)
    expect(Hook.isStage("on_stop")).toBe(true)
    expect(Hook.isStage("before_toool")).toBe(false)
  })
})

const slow = process.platform === "win32" ? "ping -n 6 127.0.0.1 >nul" : "sleep 5"
const grep = (text: string) => (process.platform === "win32" ? `findstr ${text}` : `grep ${text}`)

describe("execute", () => {
  test("runs a command to success", async () => {
    await using tmp = await temp()
    const result = await execute({ entry: { command: "echo hello", timeout: 5_000 }, cwd: tmp.path, env: {}, payload: "{}" })
    expect(result).toEqual({ ok: true })
  })

  test("reports non-zero exits", async () => {
    await using tmp = await temp()
    const result = await execute({ entry: { command: "exit 1", timeout: 5_000 }, cwd: tmp.path, env: {}, payload: "{}" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("exited with code 1")
  })

  test("writes the payload to stdin", async () => {
    await using tmp = await temp()
    const result = await execute({
      entry: { command: grep("before_tool"), timeout: 5_000 },
      cwd: tmp.path,
      env: {},
      payload: Hook.payload({ hook: "before_tool" }),
    })
    expect(result).toEqual({ ok: true })
  })

  test("kills commands that exceed their timeout", async () => {
    await using tmp = await temp()
    const result = await execute({ entry: { command: slow, timeout: 300 }, cwd: tmp.path, env: {}, payload: "{}" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("timed out after 300ms")
  })
})

describe("HooksPlugin", () => {
  const append = (file: string, text: string) => `echo ${text} >> "${file}"`

  async function setup(directory: string, hooks: Record<string, unknown>) {
    const plugin = await HooksPlugin({ directory } as unknown as PluginInput)
    await (plugin.config as unknown as (cfg: unknown) => Promise<void>)({ hooks })
    return plugin
  }

  async function log(file: string) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "")
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  test("dispatches generic tool stages before the specific ones", async () => {
    await using tmp = await temp()
    const file = path.join(tmp.path, "hooks.log")
    const plugin = await setup(tmp.path, {
      before_tool: [append(file, "before_tool")],
      before_edit: [append(file, "before_edit")],
    })
    await plugin["tool.execute.before"]!({ tool: "edit", sessionID: "ses_test", callID: "call_1" }, { args: {} })
    expect(await log(file)).toEqual(["before_tool", "before_edit"])
  })

  test("skips specific stages for unrelated tools", async () => {
    await using tmp = await temp()
    const file = path.join(tmp.path, "hooks.log")
    const plugin = await setup(tmp.path, {
      before_tool: [append(file, "before_tool")],
      before_edit: [append(file, "before_edit")],
      before_task: [append(file, "before_task")],
    })
    await plugin["tool.execute.before"]!({ tool: "read", sessionID: "ses_test", callID: "call_1" }, { args: {} })
    expect(await log(file)).toEqual(["before_tool"])
  })

  test("dispatches task stages for the task tool", async () => {
    await using tmp = await temp()
    const file = path.join(tmp.path, "hooks.log")
    const plugin = await setup(tmp.path, {
      before_task: [append(file, "before_task")],
      after_task: [append(file, "after_task")],
    })
    await plugin["tool.execute.before"]!({ tool: "task", sessionID: "ses_test", callID: "call_1" }, { args: {} })
    await plugin["tool.execute.after"]!(
      { tool: "task", sessionID: "ses_test", callID: "call_1", args: {} },
      { title: "done", output: "ok", metadata: {} },
    )
    expect(await log(file)).toEqual(["before_task", "after_task"])
  })

  test("dispatches model and commit stages", async () => {
    await using tmp = await temp()
    const file = path.join(tmp.path, "hooks.log")
    const plugin = await setup(tmp.path, {
      after_model: [append(file, "after_model")],
      before_commit: [append(file, "before_commit")],
    })
    const model = { providerID: "test", modelID: "model" }
    await plugin["model.after"]!(
      { sessionID: "ses_test", messageID: "msg_1", agent: "build", model, finish: "stop", cost: 0.1, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
      {},
    )
    await plugin["commit.before"]!({ directory: tmp.path, branch: "main", files: 2 }, { message: "chore: test" })
    expect(await log(file)).toEqual(["after_model", "before_commit"])
  })

  test("dispatches event stages and survives failing hooks", async () => {
    await using tmp = await temp()
    const file = path.join(tmp.path, "hooks.log")
    const plugin = await setup(tmp.path, {
      on_stop: [append(file, "on_stop")],
      on_error: ["exit 1", append(file, "on_error")],
    })
    const emit = plugin.event as unknown as (input: {
      event: { id: string; type: string; properties: Record<string, unknown> }
    }) => Promise<void>
    await emit({ event: { id: "evt_1", type: "session.idle", properties: { sessionID: "ses_test" } } })
    await emit({ event: { id: "evt_2", type: "session.error", properties: { sessionID: "ses_test", error: { message: "boom" } } } })
    expect(await log(file)).toEqual(["on_stop", "on_error"])
  })

  test("never throws when a command times out", async () => {
    await using tmp = await temp()
    const plugin = await setup(tmp.path, { before_tool: [{ command: slow, timeout: 300 }] })
    await plugin["tool.execute.before"]!({ tool: "read", sessionID: "ses_test", callID: "call_1" }, { args: {} })
  })
})
