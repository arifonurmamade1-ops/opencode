import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Compatibility } from "@/compatibility/audit"
import { CompatibilitySurface } from "@/compatibility/surface"

const root = join(import.meta.dir, "../../../..")
const snapshot = await CompatibilitySurface.extractSnapshot(root)
const baseline = (await Bun.file(
  join(root, "specs", "compatibility", "baseline.json"),
).json()) as Compatibility.Snapshot
const parsed = Compatibility.parseWaivers(await Bun.file(join(root, "specs", "compatibility", "waivers.json")).json())
if (parsed.problems.length > 0) throw new Error(parsed.problems.join("; "))

const testContents = new Map<string, string>()
for (const path of new Set(parsed.waivers.flatMap((waiver) => waiver.tests))) {
  const text = await Bun.file(join(root, path))
    .text()
    .catch(() => undefined)
  if (text !== undefined) testContents.set(path, text)
}

describe("CLI surface", () => {
  test("keeps the top-level commands, aliases, and global flags", () => {
    expect(snapshot.cli.commands).toEqual(
      expect.arrayContaining(["completion", "agent", "providers", "run", "serve", "plugin", "(default)"]),
    )
    expect(snapshot.cli.aliases).toEqual(expect.arrayContaining(["auth", "plug"]))
    expect(snapshot.cli.globalOptions).toEqual(
      expect.arrayContaining(["--help", "--version", "--print-logs", "--log-level", "--pure"]),
    )
  })

  test("keeps nested commands and command flags", () => {
    expect(snapshot.cli.subcommands).toEqual(
      expect.arrayContaining(["account.ts::login [url]", "providers.ts::list", "session.ts::delete <sessionID>"]),
    )
    expect(snapshot.cli.options).toEqual(expect.arrayContaining(["run.ts::--model", "uninstall.ts::--keep-config"]))
  })
})

describe("config surface", () => {
  test("keeps the top-level config keys", () => {
    expect(snapshot.config.keys).toEqual(
      expect.arrayContaining(["model", "agent", "provider", "mcp", "plugin", "permission"]),
    )
  })

  test("keeps the agent and MCP config fields", () => {
    expect(snapshot.config.agent).toEqual(expect.arrayContaining(["model", "permission", "steps", "variant"]))
    expect(snapshot.config.mcp.local).toEqual(expect.arrayContaining(["type", "command", "environment"]))
    expect(snapshot.config.mcp.remote).toEqual(expect.arrayContaining(["type", "url", "headers"]))
  })
})

describe("runtime surface", () => {
  test("keeps the built-in agents", () => {
    expect(snapshot.agents).toEqual(
      expect.arrayContaining(["build", "plan", "general", "explore", "security", "title", "summary", "compaction"]),
    )
  })

  test("keeps the built-in tools and resolves constant ids", () => {
    expect(snapshot.tools).toEqual(expect.arrayContaining(["bash", "execute", "task", "edit", "read"]))
    expect(new Set(snapshot.tools).size).toBe(snapshot.tools.length)
  })

  test("keeps the plugin API version and hooks", () => {
    expect(snapshot.plugin.apiVersion).toBe(1)
    expect(snapshot.plugin.hooks).toEqual(
      expect.arrayContaining(["event", "config", "tool", "chat.message", "tool.execute.before"]),
    )
  })

  test("keeps the TUI config keys and keybinds", () => {
    expect(snapshot.tui.config).toEqual(expect.arrayContaining(["theme", "keybinds", "attention", "scroll_speed"]))
    expect(snapshot.tui.keybinds["leader"]).toBe("ctrl+x")
    expect(snapshot.tui.keybinds["app_exit"]).toBe("ctrl+c,ctrl+d,<leader>q")
    expect(Object.keys(snapshot.tui.keybinds).length).toBeGreaterThan(100)
  })

  test("keeps the HTTP API endpoints", () => {
    expect(snapshot.api).toEqual(expect.arrayContaining(["GET /config", "PATCH /config"]))
    expect(snapshot.api.length).toBeGreaterThan(100)
  })

  test("keeps the root workflow scripts", () => {
    expect(snapshot.scripts).toEqual(expect.arrayContaining(["dev", "test", "typecheck", "license:audit"]))
  })
})

describe("committed contract", () => {
  test("the baseline matches the current tree", () => {
    expect(Compatibility.diffSnapshots(baseline, snapshot)).toEqual([])
  })

  test("every waiver is well formed and covered by tests", () => {
    const report = Compatibility.compare({
      baseline,
      current: snapshot,
      waivers: parsed.waivers,
      waiverProblems: parsed.problems,
      readTest: (path) => testContents.get(path),
    })
    expect(report.problems).toEqual([])
    expect(report.verdict).toBe("pass")
  })
})
