/**
 * Compatibility contract — FASE 32.
 *
 * OpenCode evolves in numbered phases. Existing commands, configurations,
 * agents, plugins, MCP servers, providers, workflows, scripts, API, CLI, and
 * TUI behavior should keep working across phases. This module is the pure part
 * of the guard: it diffs a committed baseline of the public surfaces against
 * the current tree and requires a justified waiver for every breaking change.
 *
 * `script/compatibility-audit.ts` extracts the current surfaces and feeds this
 * module; `test/compatibility` keeps the baseline in sync. CI runs the audit on
 * every push.
 */

export const BASELINE_VERSION = 1

export type Snapshot = {
  version: number
  cli: {
    commands: string[]
    aliases: string[]
    globalOptions: string[]
    subcommands: string[]
    subcommandAliases: string[]
    options: string[]
  }
  config: {
    keys: string[]
    agent: string[]
    mcp: {
      local: string[]
      remote: string[]
    }
  }
  agents: string[]
  tools: string[]
  plugin: {
    apiVersion: number
    hooks: string[]
  }
  tui: {
    config: string[]
    keybinds: Record<string, unknown>
  }
  api: string[]
  scripts: string[]
}

export const SURFACES = [
  "cli.commands",
  "cli.aliases",
  "cli.globalOptions",
  "cli.subcommands",
  "cli.subcommandAliases",
  "cli.options",
  "config.keys",
  "config.agent",
  "config.mcp.local",
  "config.mcp.remote",
  "agents",
  "tools",
  "plugin.apiVersion",
  "plugin.hooks",
  "tui.config",
  "tui.keybinds",
  "api",
  "scripts",
] as const

export type Surface = (typeof SURFACES)[number]

export type ChangeKind = "added" | "changed" | "removed"

export type Change = {
  surface: Surface
  path: string
  kind: ChangeKind
  before?: unknown
  after?: unknown
}

export type Waiver = {
  surface: Surface
  path: string
  reason: string
  migration: string
  tests: string[]
}

export type Verdict = "pass" | "stale" | "fail"

export type Report = {
  changes: Change[]
  compatible: Change[]
  breaking: Change[]
  waived: Change[]
  unwaived: Change[]
  appliedWaivers: Waiver[]
  historicalWaivers: Waiver[]
  problems: string[]
  verdict: Verdict
}

/**
 * Compares two snapshots. `added` entries are compatible; `removed` and
 * `changed` entries break the contract and need a waiver.
 */
export function diffSnapshots(baseline: Snapshot, current: Snapshot): Change[] {
  if (baseline.version !== current.version) {
    throw new Error(`snapshot version mismatch: baseline ${baseline.version}, current ${current.version}`)
  }
  return [
    ...diffList("cli.commands", baseline.cli.commands, current.cli.commands),
    ...diffList("cli.aliases", baseline.cli.aliases, current.cli.aliases),
    ...diffList("cli.globalOptions", baseline.cli.globalOptions, current.cli.globalOptions),
    ...diffList("cli.subcommands", baseline.cli.subcommands, current.cli.subcommands),
    ...diffList("cli.subcommandAliases", baseline.cli.subcommandAliases, current.cli.subcommandAliases),
    ...diffList("cli.options", baseline.cli.options, current.cli.options),
    ...diffList("config.keys", baseline.config.keys, current.config.keys),
    ...diffList("config.agent", baseline.config.agent, current.config.agent),
    ...diffList("config.mcp.local", baseline.config.mcp.local, current.config.mcp.local),
    ...diffList("config.mcp.remote", baseline.config.mcp.remote, current.config.mcp.remote),
    ...diffList("agents", baseline.agents, current.agents),
    ...diffList("tools", baseline.tools, current.tools),
    ...diffScalar("plugin.apiVersion", "apiVersion", baseline.plugin.apiVersion, current.plugin.apiVersion),
    ...diffList("plugin.hooks", baseline.plugin.hooks, current.plugin.hooks),
    ...diffList("tui.config", baseline.tui.config, current.tui.config),
    ...diffMap("tui.keybinds", baseline.tui.keybinds, current.tui.keybinds),
    ...diffList("api", baseline.api, current.api),
    ...diffList("scripts", baseline.scripts, current.scripts),
  ].sort(compareChanges)
}

/**
 * Builds the report for a baseline/current pair. A valid waiver must match the
 * breaking change and list at least one existing test that references it.
 */
export function compare(input: {
  baseline: Snapshot
  current: Snapshot
  waivers: readonly Waiver[]
  waiverProblems?: readonly string[]
  readTest: (path: string) => string | undefined
}): Report {
  const changes = diffSnapshots(input.baseline, input.current)
  const compatible = changes.filter((change) => change.kind === "added")
  const breaking = changes.filter((change) => change.kind !== "added")
  const checks = checkWaivers(input.waivers, breaking, input.readTest)
  const applied = new Set(checks.applied.map(waiverKey))
  const waived = breaking.filter((change) => applied.has(waiverKey(change)))
  const unwaived = breaking.filter((change) => !applied.has(waiverKey(change)))
  const problems = [...(input.waiverProblems ?? []), ...checks.problems]
  const verdict: Verdict = problems.length > 0 || unwaived.length > 0 ? "fail" : changes.length > 0 ? "stale" : "pass"
  return {
    changes,
    compatible,
    breaking,
    waived,
    unwaived,
    appliedWaivers: checks.applied,
    historicalWaivers: checks.historical,
    problems,
    verdict,
  }
}

/** Parses the `waivers.json` file without trusting its shape. */
export function parseWaivers(value: unknown): { waivers: Waiver[]; problems: string[] } {
  if (typeof value !== "object" || value === null) {
    return { waivers: [], problems: ["waivers file must contain an object"] }
  }
  const entries = (value as { waivers?: unknown }).waivers
  if (!Array.isArray(entries)) {
    return { waivers: [], problems: ['waivers file must contain a "waivers" array'] }
  }
  const waivers: Waiver[] = []
  const problems: string[] = []
  entries.forEach((entry, index) => {
    const label = `waivers[${index}]`
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${label} must be an object`)
      return
    }
    const record = entry as Record<string, unknown>
    const surface = record.surface
    if (typeof surface !== "string" || !isSurface(surface)) {
      problems.push(`${label}.surface is not a known surface`)
      return
    }
    if (typeof record.path !== "string" || !record.path.trim()) {
      problems.push(`${label}.path must be a non-empty string`)
      return
    }
    if (typeof record.reason !== "string") {
      problems.push(`${label}.reason must be a string`)
      return
    }
    if (typeof record.migration !== "string") {
      problems.push(`${label}.migration must be a string`)
      return
    }
    if (!Array.isArray(record.tests) || record.tests.some((test) => typeof test !== "string")) {
      problems.push(`${label}.tests must be an array of strings`)
      return
    }
    waivers.push({
      surface,
      path: record.path,
      reason: record.reason,
      migration: record.migration,
      tests: record.tests as string[],
    })
  })
  return { waivers, problems }
}

export function formatReport(report: Report, options: { hint?: boolean } = {}): string {
  const lines = ["compatibility contract", ""]
  lines.push(
    `changes: ${report.changes.length} (${report.compatible.length} compatible, ${report.breaking.length} breaking)`,
  )
  for (const change of report.changes) {
    const prefix = change.kind === "added" ? "+" : change.kind === "removed" ? "-" : "~"
    const suffix = change.kind === "changed" ? ` (${display(change.before)} -> ${display(change.after)})` : ""
    lines.push(`  ${prefix} ${change.surface}: ${change.path}${suffix}`)
  }
  if (report.breaking.length > 0) {
    lines.push("", `breaking: ${report.waived.length} waived, ${report.unwaived.length} unwaived`)
    for (const change of report.unwaived) lines.push(`  ! ${change.surface}: ${change.path}`)
  }
  lines.push("", `waivers: ${report.appliedWaivers.length} applied, ${report.historicalWaivers.length} historical`)
  if (report.problems.length > 0) {
    lines.push("", "problems:")
    for (const problem of report.problems) lines.push(`  ! ${problem}`)
  }
  lines.push("", `verdict: ${report.verdict.toUpperCase()}`)
  if (report.verdict === "stale" && options.hint !== false) {
    lines.push("baseline is out of date; run the audit with --update")
  }
  if (report.verdict === "fail" && report.unwaived.length > 0) {
    lines.push("breaking changes need a waiver with a reason, a migration, and tests")
  }
  return lines.join("\n")
}

/** 0 pass, 1 fail, 2 stale (the baseline needs an intentional update). */
export function reportExitCode(report: Report): number {
  if (report.verdict === "pass") return 0
  return report.verdict === "stale" ? 2 : 1
}

function diffList(surface: Surface, before: readonly string[], after: readonly string[]): Change[] {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return [
    ...[...beforeSet].filter((item) => !afterSet.has(item)).map((path): Change => ({ surface, path, kind: "removed" })),
    ...[...afterSet].filter((item) => !beforeSet.has(item)).map((path): Change => ({ surface, path, kind: "added" })),
  ]
}

function diffMap(surface: Surface, before: Record<string, unknown>, after: Record<string, unknown>): Change[] {
  const changes: Change[] = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const had = Object.hasOwn(before, key)
    const has = Object.hasOwn(after, key)
    if (!had) {
      changes.push({ surface, path: key, kind: "added", after: after[key] })
      continue
    }
    if (!has) {
      changes.push({ surface, path: key, kind: "removed", before: before[key] })
      continue
    }
    const previous = canonical(before[key])
    const next = canonical(after[key])
    if (previous !== next) changes.push({ surface, path: key, kind: "changed", before: before[key], after: after[key] })
  }
  return changes
}

function diffScalar(surface: Surface, path: string, before: unknown, after: unknown): Change[] {
  return canonical(before) === canonical(after) ? [] : [{ surface, path, kind: "changed", before, after }]
}

function checkWaivers(
  waivers: readonly Waiver[],
  breaking: readonly Change[],
  readTest: (path: string) => string | undefined,
): { applied: Waiver[]; historical: Waiver[]; problems: string[] } {
  const problems: string[] = []
  const seen = new Set<string>()
  const valid: Waiver[] = []
  const cache = new Map<string, string | undefined>()
  const read = (path: string) => {
    if (!cache.has(path)) cache.set(path, readTest(path))
    return cache.get(path)
  }
  for (const waiver of waivers) {
    const key = waiverKey(waiver)
    if (seen.has(key)) {
      problems.push(`duplicate waiver for ${waiver.surface}: ${waiver.path}`)
      continue
    }
    seen.add(key)
    const issues: string[] = []
    if (!waiver.reason.trim()) issues.push("reason is empty")
    if (!waiver.migration.trim()) issues.push("migration is empty")
    if (waiver.tests.length === 0) issues.push("no tests listed")
    const missing = waiver.tests.filter((path) => read(path) === undefined)
    if (missing.length > 0) issues.push(`test file not found: ${missing.join(", ")}`)
    if (missing.length === 0 && !waiver.tests.some((path) => (read(path) ?? "").includes(waiver.path))) {
      issues.push(`no listed test references "${waiver.path}"`)
    }
    if (issues.length > 0) {
      problems.push(`waiver ${waiver.surface}: ${waiver.path}: ${issues.join("; ")}`)
      continue
    }
    valid.push(waiver)
  }
  const applied = valid.filter((waiver) => breaking.some((change) => waiverKey(change) === waiverKey(waiver)))
  const appliedKeys = new Set(applied.map(waiverKey))
  const historical = valid.filter((waiver) => !appliedKeys.has(waiverKey(waiver)))
  return { applied, historical, problems }
}

function compareChanges(a: Change, b: Change): number {
  const surface = SURFACES.indexOf(a.surface) - SURFACES.indexOf(b.surface)
  if (surface !== 0) return surface
  const path = a.path.localeCompare(b.path)
  if (path !== 0) return path
  const kinds: Record<ChangeKind, number> = { removed: 0, changed: 1, added: 2 }
  return kinds[a.kind] - kinds[b.kind]
}

function waiverKey(value: { surface: Surface; path: string }): string {
  return `${value.surface}\u0000${value.path}`
}

function isSurface(value: string): value is Surface {
  return (SURFACES as readonly string[]).includes(value)
}

function display(value: unknown): string {
  return typeof value === "string" ? value : canonical(value)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

export * as Compatibility from "./audit"
