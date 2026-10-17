// Local-only telemetry aggregation. Pure functions: callers pass normalized
// session records (assistant turns, tool calls, durable retry events) and get
// an aggregate report back. Nothing here persists data, talks to the network,
// or reads files — the caller owns collection, this module owns arithmetic.

export interface Tokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface ToolCall {
  readonly tool: string
  readonly status: "pending" | "running" | "completed" | "error"
  readonly durationMs?: number
}

export interface Turn {
  readonly created: number
  readonly completed?: number
  readonly cost: number
  readonly tokens: Tokens
  readonly providerID: string
  readonly modelID: string
  readonly agent?: string
  readonly errorName?: string
  readonly retryable?: boolean
  readonly tools: readonly ToolCall[]
}

export interface RetryRecord {
  readonly attempt: number
  readonly timestamp: number
  readonly message: string
  readonly statusCode?: number
  readonly retryable: boolean
}

export interface Task {
  readonly id: string
  readonly created: number
  readonly updated: number
  readonly userMessages: number
  readonly turns: readonly Turn[]
  readonly retries: readonly RetryRecord[]
}

export interface Latency {
  readonly count: number
  readonly avgMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly minMs: number
  readonly maxMs: number
}

export interface ModelStat {
  readonly key: string
  readonly providerID: string
  readonly modelID: string
  readonly turns: number
  readonly tokens: Tokens
  readonly cost: number
  readonly avgLatencyMs: number
  readonly tokensPerSecond: number
}

export interface ProviderStat {
  readonly providerID: string
  readonly turns: number
  readonly tokens: Tokens
  readonly cost: number
  readonly avgLatencyMs: number
  readonly tokensPerSecond: number
}

export interface ToolStat {
  readonly tool: string
  readonly calls: number
  readonly errors: number
  readonly avgMs?: number
  readonly p95Ms?: number
}

export interface FailureStat {
  readonly name: string
  readonly count: number
}

export interface OutcomeStat {
  readonly success: number
  readonly error: number
  readonly incomplete: number
  readonly rate: number
}

export interface RangeStat {
  readonly from: number
  readonly to: number
  readonly days: number
}

export interface Report {
  readonly sessions: number
  readonly userMessages: number
  readonly turns: number
  readonly completedTurns: number
  readonly cost: number
  readonly costPerDay: number
  readonly tokens: Tokens & { readonly total: number }
  readonly latency: Latency
  readonly tokensPerSecond: number
  readonly models: readonly ModelStat[]
  readonly providers: readonly ProviderStat[]
  readonly tools: readonly ToolStat[]
  readonly failures: {
    readonly total: number
    readonly retryable: number
    readonly toolErrors: number
    readonly byName: readonly FailureStat[]
  }
  readonly retries: {
    readonly total: number
    readonly sessions: number
    readonly maxAttempt: number
    readonly retryable: number
  }
  readonly outcomes: OutcomeStat
  readonly range: RangeStat
}

const DAY_MS = 24 * 60 * 60 * 1000

type MutableTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

interface Accumulator {
  turns: number
  tokens: MutableTokens
  cost: number
  durations: number[]
  completionTokens: number
}

export function summarize(tasks: readonly Task[]): Report {
  const tokens = emptyTokens()
  const durations: number[] = []
  const models = new Map<string, Accumulator>()
  const providers = new Map<string, Accumulator>()
  const tools = new Map<string, { calls: number; errors: number; durations: number[] }>()
  const failures = new Map<string, number>()
  const outcomes = { success: 0, error: 0, incomplete: 0 }
  let cost = 0
  let userMessages = 0
  let turns = 0
  let completionTokens = 0
  let retryableFailures = 0
  let toolErrors = 0
  let retries = 0
  let retrySessions = 0
  let maxAttempt = 0
  let retryableRetries = 0
  let from = Number.POSITIVE_INFINITY
  let to = Number.NEGATIVE_INFINITY

  for (const task of tasks) {
    userMessages += task.userMessages
    from = Math.min(from, task.created)
    to = Math.max(to, task.updated)

    if (task.retries.length > 0) {
      retrySessions++
      for (const retry of task.retries) {
        retries++
        maxAttempt = Math.max(maxAttempt, retry.attempt)
        if (retry.retryable) retryableRetries++
      }
    }

    // A task (session) succeeded when its last assistant turn completed without
    // an error; an error on the last turn wins; otherwise the task is still
    // running or was never answered.
    const last = task.turns.length > 0 ? task.turns[task.turns.length - 1] : undefined
    if (!last) outcomes.incomplete++
    else if (last.errorName !== undefined) outcomes.error++
    else if (last.completed !== undefined) outcomes.success++
    else outcomes.incomplete++

    for (const turn of task.turns) {
      turns++
      cost += turn.cost
      addTokens(tokens, turn.tokens)
      if (turn.errorName !== undefined) {
        failures.set(turn.errorName, (failures.get(turn.errorName) ?? 0) + 1)
        if (turn.retryable === true) retryableFailures++
      }
      const duration =
        turn.completed !== undefined && turn.completed >= turn.created ? turn.completed - turn.created : undefined
      if (duration !== undefined) {
        durations.push(duration)
        completionTokens += turn.tokens.output + turn.tokens.reasoning
      }

      const model = accumulator(models, `${turn.providerID}/${turn.modelID}`)
      model.turns++
      model.cost += turn.cost
      addTokens(model.tokens, turn.tokens)
      if (duration !== undefined) {
        model.durations.push(duration)
        model.completionTokens += turn.tokens.output + turn.tokens.reasoning
      }

      const provider = accumulator(providers, turn.providerID)
      provider.turns++
      provider.cost += turn.cost
      addTokens(provider.tokens, turn.tokens)
      if (duration !== undefined) {
        provider.durations.push(duration)
        provider.completionTokens += turn.tokens.output + turn.tokens.reasoning
      }

      for (const call of turn.tools) {
        let tool = tools.get(call.tool)
        if (!tool) {
          tool = { calls: 0, errors: 0, durations: [] }
          tools.set(call.tool, tool)
        }
        tool.calls++
        if (call.status === "error") {
          tool.errors++
          toolErrors++
        }
        if (call.durationMs !== undefined) tool.durations.push(call.durationMs)
      }
    }
  }

  const sortedDurations = durations.toSorted((a, b) => a - b)
  const days = tasks.length === 0 ? 0 : Math.max(1, Math.ceil((to - from) / DAY_MS))
  return {
    sessions: tasks.length,
    userMessages,
    turns,
    completedTurns: durations.length,
    cost,
    costPerDay: days === 0 ? 0 : cost / days,
    tokens: {
      ...tokens,
      total: tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite,
    },
    latency: latency(sortedDurations),
    tokensPerSecond: throughput(durations, completionTokens),
    models: [...models.entries()]
      .map(([key, value]) => ({
        key,
        providerID: key.slice(0, key.indexOf("/")),
        modelID: key.slice(key.indexOf("/") + 1),
        turns: value.turns,
        tokens: { ...value.tokens },
        cost: value.cost,
        avgLatencyMs: mean(value.durations),
        tokensPerSecond: throughput(value.durations, value.completionTokens),
      }))
      .toSorted((a, b) => b.cost - a.cost || b.turns - a.turns || a.key.localeCompare(b.key)),
    providers: [...providers.entries()]
      .map(([providerID, value]) => ({
        providerID,
        turns: value.turns,
        tokens: { ...value.tokens },
        cost: value.cost,
        avgLatencyMs: mean(value.durations),
        tokensPerSecond: throughput(value.durations, value.completionTokens),
      }))
      .toSorted((a, b) => b.cost - a.cost || a.providerID.localeCompare(b.providerID)),
    tools: [...tools.entries()]
      .map(([tool, value]) => ({
        tool,
        calls: value.calls,
        errors: value.errors,
        avgMs: value.durations.length > 0 ? mean(value.durations) : undefined,
        p95Ms: value.durations.length > 0 ? percentile(value.durations.toSorted((a, b) => a - b), 95) : undefined,
      }))
      .toSorted((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
    failures: {
      total: [...failures.values()].reduce((sum, count) => sum + count, 0),
      retryable: retryableFailures,
      toolErrors,
      byName: [...failures.entries()]
        .map(([name, count]) => ({ name, count }))
        .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    },
    retries: { total: retries, sessions: retrySessions, maxAttempt, retryable: retryableRetries },
    outcomes: {
      ...outcomes,
      rate: tasks.length === 0 ? 0 : outcomes.success / tasks.length,
    },
    range: { from: tasks.length === 0 ? 0 : from, to: tasks.length === 0 ? 0 : to, days },
  }
}

function emptyTokens(): MutableTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function addTokens(target: MutableTokens, source: Tokens) {
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

function accumulator(map: Map<string, Accumulator>, key: string): Accumulator {
  const existing = map.get(key)
  if (existing) return existing
  const created: Accumulator = { turns: 0, tokens: emptyTokens(), cost: 0, durations: [], completionTokens: 0 }
  map.set(key, created)
  return created
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(sorted: readonly number[], rank: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))
  return sorted[index]!
}

function throughput(durations: readonly number[], completionTokens: number): number {
  const totalMs = durations.reduce((sum, value) => sum + value, 0)
  if (totalMs <= 0) return 0
  return completionTokens / (totalMs / 1000)
}

function latency(sortedDurations: readonly number[]): Latency {
  if (sortedDurations.length === 0) return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0 }
  return {
    count: sortedDurations.length,
    avgMs: mean(sortedDurations),
    p50Ms: percentile(sortedDurations, 50),
    p95Ms: percentile(sortedDurations, 95),
    minMs: sortedDurations[0]!,
    maxMs: sortedDurations[sortedDurations.length - 1]!,
  }
}

const PRIVACY_NOTE =
  "All figures were computed on demand from this machine's local session database; nothing was transmitted anywhere."

export function format(report: Report, options?: { top?: number }): string {
  const top = Math.max(1, options?.top ?? 10)
  if (report.sessions === 0) {
    return [
      "Local telemetry — no sessions found in scope.",
      "",
      "Nothing to report yet. Widen the window with \"days\" or run some sessions first.",
      "",
      PRIVACY_NOTE,
    ].join("\n")
  }

  const lines: string[] = ["Local telemetry — computed locally, never transmitted", ""]
  lines.push(`Range        ${date(report.range.from)} to ${date(report.range.to)} (${report.range.days} day(s))`)
  lines.push(
    `Sessions     ${report.sessions} · ${report.userMessages} user message(s) · ${report.turns} assistant turn(s)`,
  )
  lines.push(
    `Outcomes     ${report.outcomes.success} success · ${report.outcomes.error} error · ${report.outcomes.incomplete} incomplete (${Math.round(report.outcomes.rate * 100)}% success)`,
  )
  lines.push(`Cost         ${formatCost(report.cost)} total · ${formatCost(report.costPerDay)}/day`)
  lines.push(
    `Tokens       ${formatCount(report.tokens.total)} total — input ${formatCount(report.tokens.input)} · output ${formatCount(report.tokens.output)} · reasoning ${formatCount(report.tokens.reasoning)} · cache read ${formatCount(report.tokens.cacheRead)} · write ${formatCount(report.tokens.cacheWrite)}`,
  )
  lines.push(
    report.latency.count > 0
      ? `Latency      avg ${formatMs(report.latency.avgMs)} · p50 ${formatMs(report.latency.p50Ms)} · p95 ${formatMs(report.latency.p95Ms)} over ${report.latency.count} completed turn(s)`
      : "Latency      no completed turns yet",
  )
  lines.push(`Throughput   ${formatRate(report.tokensPerSecond)} (output+reasoning over completed turn time)`)

  if (report.models.length > 0) {
    lines.push("", `Models (${report.models.length})`)
    for (const model of report.models.slice(0, top)) {
      lines.push(
        `  ${model.key} — ${model.turns} turn(s) · ${formatCost(model.cost)} · ${formatCount(totalTokens(model.tokens))} tok · ${formatMs(model.avgLatencyMs)} avg · ${formatRate(model.tokensPerSecond)}`,
      )
    }
    if (report.models.length > top) lines.push(`  …and ${report.models.length - top} more`)
  }

  if (report.providers.length > 0) {
    lines.push("", `Providers (${report.providers.length})`)
    for (const provider of report.providers.slice(0, top)) {
      lines.push(
        `  ${provider.providerID} — ${provider.turns} turn(s) · ${formatCost(provider.cost)} · ${formatMs(provider.avgLatencyMs)} avg · ${formatRate(provider.tokensPerSecond)}`,
      )
    }
    if (report.providers.length > top) lines.push(`  …and ${report.providers.length - top} more`)
  }

  if (report.tools.length > 0) {
    lines.push("", `Tools (${report.tools.length})`)
    for (const tool of report.tools.slice(0, top)) {
      const timing = [
        tool.avgMs !== undefined ? `${formatMs(tool.avgMs)} avg` : undefined,
        tool.p95Ms !== undefined ? `${formatMs(tool.p95Ms)} p95` : undefined,
      ]
        .filter((entry) => entry !== undefined)
        .join(" · ")
      lines.push(
        `  ${tool.tool} — ${tool.calls} call(s) · ${tool.errors} error(s)${timing.length > 0 ? ` · ${timing}` : ""}`,
      )
    }
    if (report.tools.length > top) lines.push(`  …and ${report.tools.length - top} more`)
  }

  if (report.failures.total > 0 || report.failures.toolErrors > 0) {
    lines.push("", `Failures (${report.failures.total + report.failures.toolErrors})`)
    if (report.failures.byName.length > 0) {
      const names = report.failures.byName.map((failure) => `${failure.name} ×${failure.count}`).join(" · ")
      lines.push(`  ${names}`)
    }
    const details = [
      `${report.failures.retryable} retryable`,
      `${report.failures.toolErrors} tool error(s)`,
    ].join(" · ")
    lines.push(`  ${details}`)
  }

  if (report.retries.total > 0) {
    lines.push("", `Retries (${report.retries.total})`)
    lines.push(
      `  ${report.retries.total} retry event(s) across ${report.retries.sessions} session(s) · max attempt ${report.retries.maxAttempt} · ${report.retries.retryable} retryable`,
    )
  }

  lines.push("", PRIVACY_NOTE)
  return lines.join("\n")
}

function totalTokens(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

function date(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return `${Math.round(value)}`
}

function formatCost(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`
}

function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  return `${(value / 60_000).toFixed(1)}m`
}

function formatRate(value: number): string {
  return `${value.toFixed(1)} tok/s`
}

export * as Telemetry from "./telemetry"
