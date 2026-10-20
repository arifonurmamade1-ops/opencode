import { describe, expect, test } from "bun:test"
import { Compatibility } from "@/compatibility/audit"

function emptySnapshot(): Compatibility.Snapshot {
  return {
    version: Compatibility.BASELINE_VERSION,
    cli: {
      commands: [],
      aliases: [],
      globalOptions: [],
      subcommands: [],
      subcommandAliases: [],
      options: [],
    },
    config: { keys: [], agent: [], mcp: { local: [], remote: [] } },
    agents: [],
    tools: [],
    plugin: { apiVersion: 1, hooks: [] },
    tui: { config: [], keybinds: {} },
    api: [],
    scripts: [],
  }
}

function reader(files: Record<string, string>) {
  return (path: string) => files[path]
}

function waiver(overrides: Partial<Compatibility.Waiver> = {}): Compatibility.Waiver {
  return {
    surface: "tools",
    path: "edit",
    reason: "the tool was merged",
    migration: "automatic: edit calls are routed to write",
    tests: ["test/compatibility/migration.test.ts"],
    ...overrides,
  }
}

describe("compatibility diff", () => {
  test("classifies removed and added list entries", () => {
    const baseline = emptySnapshot()
    baseline.tools = ["bash", "edit"]
    const current = emptySnapshot()
    current.tools = ["bash", "write"]
    expect(Compatibility.diffSnapshots(baseline, current)).toEqual([
      { surface: "tools", path: "edit", kind: "removed" },
      { surface: "tools", path: "write", kind: "added" },
    ])
  })

  test("classifies keybind removals, additions, and default changes", () => {
    const baseline = emptySnapshot()
    baseline.tui.keybinds = { app_exit: "ctrl+c", leader: "ctrl+x" }
    const current = emptySnapshot()
    current.tui.keybinds = { app_new: "ctrl+n", leader: "ctrl+y" }
    expect(Compatibility.diffSnapshots(baseline, current)).toEqual([
      { surface: "tui.keybinds", path: "app_exit", kind: "removed", before: "ctrl+c" },
      { surface: "tui.keybinds", path: "app_new", kind: "added", after: "ctrl+n" },
      {
        surface: "tui.keybinds",
        path: "leader",
        kind: "changed",
        before: "ctrl+x",
        after: "ctrl+y",
      },
    ])
  })

  test("classifies plugin API version changes", () => {
    const baseline = emptySnapshot()
    const current = emptySnapshot()
    current.plugin.apiVersion = 2
    expect(Compatibility.diffSnapshots(baseline, current)).toEqual([
      { surface: "plugin.apiVersion", path: "apiVersion", kind: "changed", before: 1, after: 2 },
    ])
  })

  test("rejects mismatched snapshot versions", () => {
    const baseline = emptySnapshot()
    const current = emptySnapshot()
    current.version = 2
    expect(() => Compatibility.diffSnapshots(baseline, current)).toThrow("snapshot version mismatch")
  })
})

describe("compatibility report", () => {
  test("passes when the baseline matches", () => {
    const baseline = emptySnapshot()
    const report = Compatibility.compare({
      baseline,
      current: emptySnapshot(),
      waivers: [],
      readTest: reader({}),
    })
    expect(report.verdict).toBe("pass")
    expect(Compatibility.reportExitCode(report)).toBe(0)
  })

  test("marks a baseline with only additions as stale", () => {
    const baseline = emptySnapshot()
    const current = emptySnapshot()
    current.tools = ["write"]
    const report = Compatibility.compare({
      baseline,
      current,
      waivers: [],
      readTest: reader({}),
    })
    expect(report.verdict).toBe("stale")
    expect(report.breaking).toEqual([])
    expect(report.compatible).toHaveLength(1)
    expect(Compatibility.reportExitCode(report)).toBe(2)
  })

  test("fails an unwaived breaking change", () => {
    const baseline = emptySnapshot()
    baseline.tools = ["edit"]
    const report = Compatibility.compare({
      baseline,
      current: emptySnapshot(),
      waivers: [],
      readTest: reader({}),
    })
    expect(report.verdict).toBe("fail")
    expect(report.unwaived).toHaveLength(1)
    expect(Compatibility.reportExitCode(report)).toBe(1)
  })

  test("accepts a breaking change covered by a valid waiver", () => {
    const baseline = emptySnapshot()
    baseline.tools = ["edit"]
    const report = Compatibility.compare({
      baseline,
      current: emptySnapshot(),
      waivers: [waiver()],
      readTest: reader({ "test/compatibility/migration.test.ts": 'test("edit migration", () => {})' }),
    })
    expect(report.verdict).toBe("stale")
    expect(report.waived).toHaveLength(1)
    expect(report.appliedWaivers).toHaveLength(1)
    expect(report.problems).toEqual([])
  })

  test("rejects a waiver without a reason", () => {
    const baseline = emptySnapshot()
    baseline.tools = ["edit"]
    const report = Compatibility.compare({
      baseline,
      current: emptySnapshot(),
      waivers: [waiver({ reason: " " })],
      readTest: reader({ "test/compatibility/migration.test.ts": 'test("edit migration", () => {})' }),
    })
    expect(report.verdict).toBe("fail")
    expect(report.problems.join(" ")).toContain("reason is empty")
  })

  test("rejects a waiver whose test file is missing", () => {
    const baseline = emptySnapshot()
    baseline.tools = ["edit"]
    const report = Compatibility.compare({
      baseline,
      current: emptySnapshot(),
      waivers: [waiver()],
      readTest: reader({}),
    })
    expect(report.verdict).toBe("fail")
    expect(report.problems.join(" ")).toContain("test file not found")
  })

  test("rejects a waiver whose test does not reference the change", () => {
    const baseline = emptySnapshot()
    baseline.tools = ["edit"]
    const report = Compatibility.compare({
      baseline,
      current: emptySnapshot(),
      waivers: [waiver()],
      readTest: reader({ "test/compatibility/migration.test.ts": 'test("unrelated", () => {})' }),
    })
    expect(report.verdict).toBe("fail")
    expect(report.problems.join(" ")).toContain('no listed test references "edit"')
  })

  test("keeps valid historical waivers without failing", () => {
    const report = Compatibility.compare({
      baseline: emptySnapshot(),
      current: emptySnapshot(),
      waivers: [waiver()],
      readTest: reader({ "test/compatibility/migration.test.ts": 'test("edit migration", () => {})' }),
    })
    expect(report.verdict).toBe("pass")
    expect(report.historicalWaivers).toHaveLength(1)
    expect(report.appliedWaivers).toEqual([])
  })

  test("rejects duplicate waivers", () => {
    const baseline = emptySnapshot()
    baseline.tools = ["edit"]
    const report = Compatibility.compare({
      baseline,
      current: emptySnapshot(),
      waivers: [waiver(), waiver()],
      readTest: reader({ "test/compatibility/migration.test.ts": 'test("edit migration", () => {})' }),
    })
    expect(report.verdict).toBe("fail")
    expect(report.problems.join(" ")).toContain("duplicate waiver")
  })

  test("formats a failing report with the change and the next step", () => {
    const baseline = emptySnapshot()
    baseline.tools = ["edit"]
    const report = Compatibility.compare({
      baseline,
      current: emptySnapshot(),
      waivers: [],
      readTest: reader({}),
    })
    const text = Compatibility.formatReport(report)
    expect(text).toContain("verdict: FAIL")
    expect(text).toContain("tools: edit")
    expect(text).toContain("breaking changes need a waiver")
  })
})

describe("waiver parsing", () => {
  test("rejects malformed files and unknown surfaces", () => {
    expect(Compatibility.parseWaivers(undefined).problems).toHaveLength(1)
    expect(Compatibility.parseWaivers({}).problems[0]).toContain('"waivers" array')
    const parsed = Compatibility.parseWaivers({
      waivers: [{ surface: "not-a-surface", path: "x", reason: "r", migration: "m", tests: [] }],
    })
    expect(parsed.waivers).toEqual([])
    expect(parsed.problems[0]).toContain("not a known surface")
  })

  test("parses a valid waiver", () => {
    const parsed = Compatibility.parseWaivers({ waivers: [waiver()] })
    expect(parsed.problems).toEqual([])
    expect(parsed.waivers).toEqual([waiver()])
  })
})
