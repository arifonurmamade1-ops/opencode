export * as Hook from "./hook"

// User-configured lifecycle hooks.
//
// Hooks are shell commands declared under "hooks" in opencode.json, keyed by
// the stage of a session they run at. This module is the pure core: it
// validates and normalizes the raw config value, merges global and project
// configurations, and builds the environment/payload a command receives.
// Executing the commands lives in ./plugin.

/** Critical session stages a hook command can run at. */
export const STAGES = [
  "before_task",
  "after_task",
  "before_tool",
  "after_tool",
  "before_model",
  "after_model",
  "before_edit",
  "after_edit",
  "before_commit",
  "after_commit",
  "on_error",
  "on_stop",
] as const

export type Stage = (typeof STAGES)[number]

export type Entry = {
  command: string
  timeout: number
}

export type Definitions = { [stage in Stage]?: Entry[] }

export const DEFAULT_TIMEOUT = 30_000

const MIN_TIMEOUT = 100

/** Longest string field kept in a hook payload before it is truncated. */
export const MAX_STRING = 32_000

const known = new Set<string>(STAGES)

export function isStage(value: string): value is Stage {
  return known.has(value)
}

/**
 * Normalize the raw `hooks` config value into executable definitions.
 *
 * The config schema is intentionally loose (arbitrary JSON), so everything a
 * user can get wrong is reported as a problem instead of breaking config load
 * or silently never running. Invalid stages and entries are skipped.
 */
export function normalize(raw: unknown): { hooks: Definitions; problems: string[] } {
  const hooks: Definitions = {}
  const problems: string[] = []
  if (raw === undefined || raw === null) return { hooks, problems }
  if (!isRecord(raw)) return { hooks, problems: ["hooks must be an object of stage -> command(s)"] }

  for (const [stage, value] of Object.entries(raw)) {
    if (!isStage(stage)) {
      problems.push(`unknown hook stage "${stage}" (known stages: ${STAGES.join(", ")})`)
      continue
    }
    const entries = readList(value).flatMap((item, index) => {
      const entry = readEntry(item, Array.isArray(value) ? `${stage}[${index}]` : stage, problems)
      return entry ? [entry] : []
    })
    if (entries.length) hooks[stage] = entries
  }

  return { hooks, problems }
}

/**
 * Merge two raw `hooks` values, concatenating each stage (target first).
 *
 * Global config is merged into the project config, so both scopes run for a
 * project. Exact duplicates are dropped so the same command listed twice does
 * not run twice. Returns undefined when either value is not an object: a
 * malformed value is then left for normalize to report instead of being
 * silently discarded.
 */
export function merge(target: unknown, source: unknown): Record<string, unknown> | undefined {
  if (!isMergeable(target) || !isMergeable(source)) return undefined
  if (target === undefined && source === undefined) return undefined
  const result: Record<string, unknown[]> = {}
  for (const raw of [target, source]) {
    if (!isRecord(raw)) continue
    for (const [stage, value] of Object.entries(raw)) {
      const list = (result[stage] ??= [])
      for (const item of readList(value)) {
        if (!list.some((existing) => same(existing, item))) list.push(item)
      }
    }
  }
  return result
}

function isMergeable(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value)
}

/** Environment variables every hook command receives. */
export function environment(input: {
  stage: Stage
  directory: string
  sessionID?: string
  tool?: string
}): Record<string, string> {
  const env: Record<string, string> = {
    OPENCODE_HOOK: input.stage,
    OPENCODE_HOOK_DIRECTORY: input.directory,
  }
  if (input.sessionID) env.OPENCODE_HOOK_SESSION = input.sessionID
  if (input.tool) env.OPENCODE_HOOK_TOOL = input.tool
  return env
}

/** Serialize a hook payload, truncating very long strings. */
export function payload(input: Record<string, unknown>): string {
  return JSON.stringify(input, (_key, value) =>
    typeof value === "string" && value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(${value.length} chars truncated)`
      : value,
  )
}

/** Render configured hooks for humans and models. */
export function format(hooks: Definitions, problems: readonly string[] = []): string {
  const configured = STAGES.filter((stage) => (hooks[stage]?.length ?? 0) > 0)
  const commands = configured.reduce((total, stage) => total + (hooks[stage]?.length ?? 0), 0)
  const lines: string[] = []
  if (!configured.length) {
    lines.push("No lifecycle hooks are configured for this project (global and project config merged).")
  } else {
    lines.push(`Lifecycle hooks (global + project config merged): ${configured.length} stage(s), ${commands} command(s).`)
    for (const stage of configured) {
      lines.push("", `${stage}:`)
      for (const entry of hooks[stage] ?? []) {
        const detail =
          entry.timeout === DEFAULT_TIMEOUT
            ? ""
            : ` (timeout ${entry.timeout >= 1000 ? `${Math.round(entry.timeout / 1000)}s` : `${entry.timeout}ms`})`
        lines.push(`  - ${entry.command}${detail}`)
      }
    }
  }
  if (problems.length) lines.push("", "Problems:", ...problems.map((problem) => `  - ${problem}`))
  return lines.join("\n")
}

function readList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value]
}

function readEntry(value: unknown, label: string, problems: string[]): Entry | undefined {
  if (typeof value === "string") {
    const command = value.trim()
    if (!command) {
      problems.push(`"${label}" is an empty command`)
      return
    }
    return { command, timeout: DEFAULT_TIMEOUT }
  }
  if (!isRecord(value)) {
    problems.push(`"${label}" must be a command string or an object with a "command"`)
    return
  }
  if (typeof value.command !== "string" || !value.command.trim()) {
    problems.push(`"${label}.command" must be a non-empty string`)
    return
  }
  if (
    value.timeout !== undefined &&
    (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout < MIN_TIMEOUT)
  ) {
    problems.push(`"${label}.timeout" must be a number of milliseconds >= ${MIN_TIMEOUT}; using the default`)
    return { command: value.command.trim(), timeout: DEFAULT_TIMEOUT }
  }
  return {
    command: value.command.trim(),
    timeout: typeof value.timeout === "number" ? value.timeout : DEFAULT_TIMEOUT,
  }
}

function same(left: unknown, right: unknown): boolean {
  return typeof left === "string" || typeof right === "string" ? left === right : JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
