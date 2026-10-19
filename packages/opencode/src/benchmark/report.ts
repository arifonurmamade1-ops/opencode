/**
 * Internal benchmark report model — FASE 30.
 *
 * Defines the twelve evaluation categories, concrete per-case metrics, run
 * records, and the objective comparison between two runs ("current" vs "new").
 *
 * The comparison reports measured deltas inside a noise band and marks runs
 * with fewer than `MIN_SIGNIFICANT_SAMPLES` samples as descriptive only, so a
 * benchmark run never turns into an unmeasured superiority claim.
 */

export const CATEGORIES = [
  { id: "coding", label: "Coding" },
  { id: "debugging", label: "Debugging" },
  { id: "refactoring", label: "Refactoring" },
  { id: "browser", label: "Browser automation" },
  { id: "ui", label: "UI testing" },
  { id: "multi-agent", label: "Multi-agent" },
  { id: "long-running", label: "Long-running tasks" },
  { id: "recovery", label: "Recovery" },
  { id: "context", label: "Context handling" },
  { id: "security", label: "Security" },
  { id: "routing", label: "Model routing" },
  { id: "cost", label: "Cost efficiency" },
] as const

export type CategoryID = (typeof CATEGORIES)[number]["id"]

/** Metric polarity: which direction counts as an improvement when comparing runs. */
export type Direction = "higher" | "lower" | "info"

export type CaseStatus = "pass" | "fail" | "unavailable" | "error"

export type MetricSample = { readonly value: number; readonly direction: Direction }

export type Metrics = Record<string, MetricSample>

export type CaseResult = {
  readonly status: CaseStatus
  readonly metrics?: Metrics
  readonly detail?: string
}

/** Static description of a benchmark case, independent of any execution. */
export type CaseInfo = {
  readonly id: string
  readonly category: CategoryID
  readonly title: string
  readonly description: string
  readonly metrics: Record<string, Direction>
}

/** Recorded outcome of one case inside one run. */
export type RunCase = {
  readonly id: string
  readonly category: CategoryID
  readonly title: string
  readonly status: CaseStatus
  readonly samples: number
  readonly metrics: Metrics
  readonly detail?: string
}

export type RunEnvironment = {
  readonly platform: string
  readonly arch: string
  readonly bun: string
}

/** One persisted benchmark execution. */
export type Run = {
  readonly id: string
  readonly label?: string
  readonly createdAt: string
  readonly durationMs: number
  readonly environment: RunEnvironment
  readonly cases: readonly RunCase[]
}

export type RunSummary = {
  readonly id: string
  readonly label?: string
  readonly createdAt: string
  readonly durationMs: number
  readonly total: number
  readonly pass: number
  readonly fail: number
  readonly unavailable: number
  readonly error: number
}

export type Verdict = "better" | "worse" | "same" | "within-noise" | "informational" | "missing"

export type MetricDelta = {
  readonly caseID: string
  readonly metric: string
  readonly direction: Direction
  readonly a?: number | undefined
  readonly b?: number | undefined
  readonly delta?: number | undefined
  readonly deltaPct?: number | undefined
  readonly verdict: Verdict
}

export type CaseDelta = {
  readonly id: string
  readonly category: CategoryID
  readonly title: string
  readonly statusA: CaseStatus | "missing"
  readonly statusB: CaseStatus | "missing"
  readonly metrics: readonly MetricDelta[]
}

export type Comparison = {
  readonly a: RunSummary
  readonly b: RunSummary
  readonly noise: number
  readonly significant: boolean
  readonly minSamples: number
  readonly counts: Record<Verdict, number>
  readonly cases: readonly CaseDelta[]
}

/** Below this many samples per side, a comparison is descriptive only. */
export const MIN_SIGNIFICANT_SAMPLES = 3

/** Relative deltas inside this band are reported as noise for directional metrics. */
export const NOISE_BAND = 0.1

const VERDICT_ORDER: readonly Verdict[] = ["better", "worse", "same", "within-noise", "informational", "missing"]

export function categoryLabel(category: CategoryID): string {
  return CATEGORIES.find((item) => item.id === category)?.label ?? category
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Combines repeated executions of one case into its recorded form. Numeric
 * metrics use the median so a single slow/fast outlier cannot define the run.
 */
export function aggregate(info: CaseInfo, results: readonly CaseResult[]): RunCase {
  const status: CaseStatus = results.some((result) => result.status === "pass")
    ? "pass"
    : results.some((result) => result.status === "fail")
      ? "fail"
      : results.some((result) => result.status === "unavailable")
        ? "unavailable"
        : "error"

  const metrics: Metrics = {}
  for (const name of Object.keys(info.metrics)) {
    const direction = info.metrics[name]!
    const values = results
      .map((result) => result.metrics?.[name]?.value)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    if (values.length > 0) metrics[name] = { value: median(values), direction }
  }

  const detail = results.find((result) => result.detail !== undefined)?.detail
  return {
    id: info.id,
    category: info.category,
    title: info.title,
    status,
    samples: results.length,
    metrics,
    ...(detail !== undefined ? { detail } : {}),
  }
}

export function summarizeRun(run: Run): RunSummary {
  return {
    id: run.id,
    ...(run.label !== undefined ? { label: run.label } : {}),
    createdAt: run.createdAt,
    durationMs: run.durationMs,
    total: run.cases.length,
    pass: run.cases.filter((item) => item.status === "pass").length,
    fail: run.cases.filter((item) => item.status === "fail").length,
    unavailable: run.cases.filter((item) => item.status === "unavailable").length,
    error: run.cases.filter((item) => item.status === "error").length,
  }
}

export function compareRuns(a: Run, b: Run, options?: { readonly noise?: number }): Comparison {
  const noise = options?.noise ?? NOISE_BAND
  const aCases = new Map(a.cases.map((item) => [item.id, item]))
  const bCases = new Map(b.cases.map((item) => [item.id, item]))
  const ids = [...new Set([...aCases.keys(), ...bCases.keys()])].toSorted()
  const comparedSamples: number[] = []
  const counts: Record<Verdict, number> = {
    better: 0,
    worse: 0,
    same: 0,
    "within-noise": 0,
    informational: 0,
    missing: 0,
  }

  const cases = ids.map((id): CaseDelta => {
    const left = aCases.get(id)
    const right = bCases.get(id)
    const names = [...new Set([...Object.keys(left?.metrics ?? {}), ...Object.keys(right?.metrics ?? {})])].toSorted()
    const metrics = names.map((metric): MetricDelta => {
      const sampleA = left?.metrics[metric]
      const sampleB = right?.metrics[metric]
      const direction = sampleA?.direction ?? sampleB?.direction ?? "info"
      const delta = deltaOf(id, metric, direction, sampleA?.value, sampleB?.value, noise)
      counts[delta.verdict] += 1
      return delta
    })
    if (left !== undefined && right !== undefined) comparedSamples.push(Math.min(left.samples, right.samples))
    return {
      id,
      category: left?.category ?? right!.category,
      title: left?.title ?? right!.title,
      statusA: left?.status ?? "missing",
      statusB: right?.status ?? "missing",
      metrics,
    }
  })

  const minSamples = comparedSamples.length > 0 ? Math.min(...comparedSamples) : 0
  return {
    a: summarizeRun(a),
    b: summarizeRun(b),
    noise,
    significant: minSamples >= MIN_SIGNIFICANT_SAMPLES,
    minSamples,
    counts,
    cases,
  }
}

function deltaOf(
  caseID: string,
  metric: string,
  direction: Direction,
  a: number | undefined,
  b: number | undefined,
  noise: number,
): MetricDelta {
  if (a === undefined || b === undefined) {
    return { caseID, metric, direction, a, b, verdict: "missing" }
  }
  const delta = b - a
  const deltaPct = a === 0 ? undefined : (delta / Math.abs(a)) * 100
  return {
    caseID,
    metric,
    direction,
    a,
    b,
    delta,
    deltaPct,
    verdict: verdictOf(direction, delta, deltaPct, noise),
  }
}

function verdictOf(direction: Direction, delta: number, deltaPct: number | undefined, noise: number): Verdict {
  if (delta === 0) return "same"
  if (direction === "info") return "informational"
  if (deltaPct !== undefined && Math.abs(deltaPct) / 100 <= noise) return "within-noise"
  if (direction === "higher") return delta > 0 ? "better" : "worse"
  return delta < 0 ? "better" : "worse"
}

export function formatCatalog(cases: readonly CaseInfo[]): string {
  const lines: string[] = []
  for (const category of CATEGORIES) {
    const items = cases.filter((item) => item.category === category.id)
    if (items.length === 0) continue
    lines.push(`[${category.id}] ${category.label}`)
    for (const item of items) {
      lines.push(`  ${item.id} — ${item.title}`)
      lines.push(`    ${item.description}`)
      lines.push(`    metrics: ${describeMetrics(item.metrics)}`)
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function formatRuns(runs: readonly RunSummary[]): string {
  if (runs.length === 0) return "No benchmark runs recorded yet."
  return runs
    .map(
      (run) =>
        `${run.id}${run.label ? ` (${run.label})` : ""} — ${run.total} cases (${run.pass} pass, ${run.fail} fail, ` +
        `${run.unavailable} unavailable, ${run.error} error) — ${Math.round(run.durationMs)}ms — ${run.createdAt}`,
    )
    .join("\n")
}

export function formatRun(run: Run): string {
  const summary = summarizeRun(run)
  const lines = [
    `Benchmark run ${run.id}${run.label ? ` (${run.label})` : ""} — ${summary.total} cases ` +
      `(${summary.pass} pass, ${summary.fail} fail, ${summary.unavailable} unavailable, ${summary.error} error) — ` +
      `${Math.round(run.durationMs)}ms`,
    `environment: ${run.environment.platform}/${run.environment.arch} bun ${run.environment.bun}`,
    "",
  ]
  for (const item of run.cases) {
    const suffix = item.samples > 1 ? ` (${item.samples} samples, median)` : ""
    lines.push(`[${item.category}] ${item.id} — ${item.status}${suffix}`)
    const metrics = Object.entries(item.metrics)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, sample]) => `${name}=${formatNumber(sample.value)}`)
      .join(" ")
    if (metrics.length > 0) lines.push(`  ${metrics}`)
    if (item.detail !== undefined) lines.push(`  detail: ${item.detail}`)
  }
  return lines.join("\n")
}

export function formatComparison(comparison: Comparison): string {
  const lines = [
    `Benchmark comparison: ${describeRun(comparison.a)} (A) vs ${describeRun(comparison.b)} (B)`,
    `delta is B - A; noise band: +/-${formatNumber(comparison.noise * 100)}%`,
    comparison.significant
      ? `significance: yes (minimum samples ${comparison.minSamples} >= ${MIN_SIGNIFICANT_SAMPLES})`
      : `significance: no (minimum samples ${comparison.minSamples} < ${MIN_SIGNIFICANT_SAMPLES}) — descriptive only`,
    `verdicts: ${VERDICT_ORDER.map((verdict) => `${verdict}=${comparison.counts[verdict]}`).join(" ")}`,
    "",
  ]
  for (const item of comparison.cases) {
    lines.push(`[${item.category}] ${item.id} (${item.statusA} -> ${item.statusB})`)
    for (const metric of item.metrics) {
      lines.push(`  ${metric.metric}: ${describeDelta(metric)}`)
    }
  }
  return lines.join("\n").trimEnd()
}

function describeDelta(metric: MetricDelta): string {
  if (metric.a === undefined || metric.b === undefined) {
    return `missing on one side [${metric.verdict}]`
  }
  const delta = metric.delta ?? 0
  const pct = metric.deltaPct === undefined ? "" : `, ${formatSigned(metric.deltaPct)}%`
  return `${formatNumber(metric.a)} -> ${formatNumber(metric.b)} (delta ${formatSigned(delta)}${pct}) [${metric.verdict}]`
}

function describeRun(run: RunSummary): string {
  return `${run.id}${run.label ? ` "${run.label}"` : ""}`
}

function describeMetrics(metrics: Record<string, Direction>): string {
  const names = Object.keys(metrics).toSorted()
  if (names.length === 0) return "none"
  return names.map((name) => `${name} (${metrics[name]})`).join(", ")
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

function formatSigned(value: number): string {
  const text = formatNumber(Math.abs(value))
  return value > 0 ? `+${text}` : value < 0 ? `-${text}` : "0"
}

export * as BenchmarkReport from "./report"
