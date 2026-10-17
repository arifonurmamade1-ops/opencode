import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/telemetry/telemetry"

const DAY = 24 * 60 * 60 * 1000

const tokens = (
  input = 0,
  output = 0,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite = 0,
): Telemetry.Tokens => ({ input, output, reasoning, cacheRead, cacheWrite })

function turn(overrides: Partial<Telemetry.Turn> = {}): Telemetry.Turn {
  return {
    created: 0,
    completed: 1000,
    cost: 0,
    tokens: tokens(),
    providerID: "openai",
    modelID: "gpt-5",
    tools: [],
    ...overrides,
  }
}

function task(overrides: Partial<Telemetry.Task> = {}): Telemetry.Task {
  return {
    id: "ses_1",
    created: 0,
    updated: 1000,
    userMessages: 1,
    turns: [],
    retries: [],
    ...overrides,
  }
}

describe("summarize", () => {
  test("returns a zeroed report for no tasks", () => {
    const report = Telemetry.summarize([])
    expect(report.sessions).toBe(0)
    expect(report.turns).toBe(0)
    expect(report.cost).toBe(0)
    expect(report.costPerDay).toBe(0)
    expect(report.tokens.total).toBe(0)
    expect(report.latency.count).toBe(0)
    expect(report.tokensPerSecond).toBe(0)
    expect(report.outcomes.rate).toBe(0)
    expect(report.range).toEqual({ from: 0, to: 0, days: 0 })
  })

  test("counts sessions, user messages and assistant turns", () => {
    const report = Telemetry.summarize([
      task({ id: "a", userMessages: 2, turns: [turn(), turn()] }),
      task({ id: "b", userMessages: 1, turns: [turn()] }),
    ])
    expect(report.sessions).toBe(2)
    expect(report.userMessages).toBe(3)
    expect(report.turns).toBe(3)
  })

  test("sums tokens including a computed total", () => {
    const report = Telemetry.summarize([
      task({ turns: [turn({ tokens: tokens(100, 10, 5, 1000, 20) }), turn({ tokens: tokens(50, 5, 0, 500, 10) })] }),
    ])
    expect(report.tokens.input).toBe(150)
    expect(report.tokens.output).toBe(15)
    expect(report.tokens.reasoning).toBe(5)
    expect(report.tokens.cacheRead).toBe(1500)
    expect(report.tokens.cacheWrite).toBe(30)
    expect(report.tokens.total).toBe(1700)
  })

  test("sums cost and derives a per-day value from the range", () => {
    const report = Telemetry.summarize([
      task({ created: 0, updated: 0, turns: [turn({ cost: 4, created: 0, completed: 0 })] }),
      task({ id: "b", created: 0, updated: 2 * DAY, turns: [turn({ cost: 6 })] }),
    ])
    expect(report.cost).toBe(10)
    expect(report.range.days).toBe(2)
    expect(report.costPerDay).toBe(5)
  })

  test("computes latency percentiles over completed turns", () => {
    const report = Telemetry.summarize([
      task({
        turns: [
          turn({ created: 0, completed: 1000 }),
          turn({ created: 0, completed: 2000 }),
          turn({ created: 0, completed: 3000 }),
          turn({ created: 0, completed: 4000 }),
        ],
      }),
    ])
    expect(report.latency).toEqual({
      count: 4,
      avgMs: 2500,
      p50Ms: 2000,
      p95Ms: 4000,
      minMs: 1000,
      maxMs: 4000,
    })
  })

  test("uses nearest-rank percentiles for small samples", () => {
    const report = Telemetry.summarize([
      task({
        turns: [
          turn({ created: 0, completed: 100 }),
          turn({ created: 0, completed: 200 }),
          turn({ created: 0, completed: 1000 }),
        ],
      }),
    ])
    expect(report.latency.p50Ms).toBe(200)
    expect(report.latency.p95Ms).toBe(1000)
  })

  test("ignores turns that have not completed", () => {
    const report = Telemetry.summarize([
      task({
        turns: [
          turn({ created: 0, completed: 500 }),
          turn({ created: 0, completed: undefined }),
          turn({ created: 0, completed: 1500 }),
        ],
      }),
    ])
    expect(report.latency.count).toBe(2)
    expect(report.completedTurns).toBe(2)
    expect(report.latency.avgMs).toBe(1000)
  })

  test("ignores negative durations", () => {
    const report = Telemetry.summarize([task({ turns: [turn({ created: 5000, completed: 1000 })] })])
    expect(report.latency.count).toBe(0)
    expect(report.turns).toBe(1)
  })

  test("derives throughput from output and reasoning tokens over turn time", () => {
    const report = Telemetry.summarize([
      task({ turns: [turn({ created: 0, completed: 2000, tokens: tokens(1000, 100, 20) })] }),
    ])
    expect(report.tokensPerSecond).toBe(60)
  })

  test("aggregates per-model stats and sorts by cost", () => {
    const report = Telemetry.summarize([
      task({
        turns: [
          turn({ providerID: "anthropic", modelID: "claude", cost: 0.5, tokens: tokens(10, 1) }),
          turn({ providerID: "openai", modelID: "gpt-5", cost: 2, tokens: tokens(20, 2), created: 0, completed: 1000 }),
        ],
      }),
    ])
    expect(report.models.map((model) => model.key)).toEqual(["openai/gpt-5", "anthropic/claude"])
    const openai = report.models[0]
    expect(openai.turns).toBe(1)
    expect(openai.cost).toBe(2)
    expect(openai.tokens.input).toBe(20)
    expect(openai.tokensPerSecond).toBe(2)
  })

  test("aggregates per-provider stats", () => {
    const report = Telemetry.summarize([
      task({
        turns: [
          turn({ providerID: "openai", modelID: "gpt-5", cost: 1 }),
          turn({ providerID: "openai", modelID: "o4", cost: 2 }),
          turn({ providerID: "anthropic", modelID: "claude", cost: 5 }),
        ],
      }),
    ])
    expect(report.providers[0].providerID).toBe("anthropic")
    expect(report.providers[1].providerID).toBe("openai")
    expect(report.providers[1].turns).toBe(2)
    expect(report.providers[1].cost).toBe(3)
  })

  test("aggregates tool calls, errors and timings", () => {
    const report = Telemetry.summarize([
      task({
        turns: [
          turn({
            tools: [
              { tool: "bash", status: "completed", durationMs: 100 },
              { tool: "bash", status: "error", durationMs: 200 },
              { tool: "bash", status: "completed", durationMs: 300 },
              { tool: "edit", status: "completed", durationMs: 1000 },
            ],
          }),
        ],
      }),
    ])
    expect(report.tools.map((tool) => tool.tool)).toEqual(["bash", "edit"])
    const bash = report.tools[0]
    expect(bash.calls).toBe(3)
    expect(bash.errors).toBe(1)
    expect(bash.avgMs).toBe(200)
    expect(bash.p95Ms).toBe(300)
    expect(report.failures.toolErrors).toBe(1)
  })

  test("counts untimed tool calls without a duration", () => {
    const report = Telemetry.summarize([
      task({ turns: [turn({ tools: [{ tool: "read", status: "running" }] })] }),
    ])
    expect(report.tools[0].calls).toBe(1)
    expect(report.tools[0].avgMs).toBeUndefined()
    expect(report.tools[0].p95Ms).toBeUndefined()
  })

  test("counts failures by name and retryable assistant errors", () => {
    const report = Telemetry.summarize([
      task({
        turns: [
          turn({ errorName: "APIError", retryable: true }),
          turn({ errorName: "APIError", retryable: true }),
          turn({ errorName: "MessageAbortedError" }),
        ],
      }),
    ])
    expect(report.failures.total).toBe(3)
    expect(report.failures.retryable).toBe(2)
    expect(report.failures.byName).toEqual([
      { name: "APIError", count: 2 },
      { name: "MessageAbortedError", count: 1 },
    ])
  })

  test("aggregates retry events", () => {
    const report = Telemetry.summarize([
      task({
        id: "a",
        retries: [
          { attempt: 1, timestamp: 10, message: "rate limited", retryable: true },
          { attempt: 2, timestamp: 20, message: "rate limited", retryable: true },
        ],
      }),
      task({ id: "b", retries: [{ attempt: 3, timestamp: 30, message: "5xx", statusCode: 500, retryable: false }] }),
    ])
    expect(report.retries).toEqual({ total: 3, sessions: 2, maxAttempt: 3, retryable: 2 })
  })

  test("derives per-task outcomes from the last assistant turn", () => {
    const report = Telemetry.summarize([
      task({ id: "success", turns: [turn({ errorName: "APIError" }), turn()] }),
      task({ id: "error", turns: [turn({ errorName: "APIError" })] }),
      task({ id: "running", turns: [turn({ completed: undefined })] }),
      task({ id: "empty", turns: [], userMessages: 1 }),
    ])
    expect(report.outcomes).toEqual({ success: 1, error: 1, incomplete: 2, rate: 0.25 })
  })

  test("treats a last turn with an error as failed even when completed is set", () => {
    const report = Telemetry.summarize([
      task({ turns: [turn({ created: 0, completed: 100 }), turn({ created: 200, completed: 300, errorName: "APIError" })] }),
    ])
    expect(report.outcomes.error).toBe(1)
    expect(report.outcomes.success).toBe(0)
    expect(report.latency.count).toBe(2)
  })

  test("computes the range across tasks with at least one day", () => {
    const report = Telemetry.summarize([
      task({ created: 5000, updated: 5000 }),
      task({ id: "b", created: 1000, updated: 1000 }),
    ])
    expect(report.range.from).toBe(1000)
    expect(report.range.to).toBe(5000)
    expect(report.range.days).toBe(1)
  })
})

describe("format", () => {
  test("renders an empty report with the privacy note", () => {
    const output = Telemetry.format(Telemetry.summarize([]))
    expect(output).toContain("no sessions found in scope")
    expect(output).toContain("nothing was transmitted anywhere")
  })

  test("renders the full report with formatted numbers", () => {
    const output = Telemetry.format(
      Telemetry.summarize([
        task({
          created: 0,
          updated: 2 * DAY,
          turns: [
            turn({ cost: 12.5, tokens: tokens(1_500_000, 120_000, 40_000), created: 0, completed: 2000 }),
            turn({
              created: 0,
              completed: 4000,
              tools: [
                { tool: "bash", status: "completed", durationMs: 900 },
                { tool: "bash", status: "error", durationMs: 2100 },
              ],
            }),
          ],
          retries: [{ attempt: 1, timestamp: 5, message: "rate limited", retryable: true }],
        }),
      ]),
    )
    expect(output).toContain("Local telemetry — computed locally, never transmitted")
    expect(output).toContain("1970-01-01 to 1970-01-03 (2 day(s))")
    expect(output).toContain("$12.50 total · $6.25/day")
    expect(output).toContain("1.7M total — input 1.5M")
    expect(output).toContain("120.0K")
    expect(output).toContain("avg 3.0s · p50 2.0s · p95 4.0s over 2 completed turn(s)")
    expect(output).toContain("26666.7 tok/s")
    expect(output).toContain("Models (1)")
    expect(output).toContain("openai/gpt-5")
    expect(output).toContain("Tools (1)")
    expect(output).toContain("bash — 2 call(s) · 1 error(s) · 1.5s avg · 2.1s p95")
    expect(output).toContain("Failures (1)")
    expect(output).toContain("1 tool error(s)")
    expect(output).toContain("Retries (1)")
    expect(output).toContain("1 retry event(s) across 1 session(s) · max attempt 1 · 1 retryable")
    expect(output).toContain("nothing was transmitted anywhere")
  })

  test("limits ranked lists to the requested top and notes the remainder", () => {
    const output = Telemetry.format(
      Telemetry.summarize([
        task({
          turns: [
            turn({ modelID: "a", providerID: "p1", cost: 3 }),
            turn({ modelID: "b", providerID: "p2", cost: 2 }),
            turn({ modelID: "c", providerID: "p3", cost: 1 }),
          ],
        }),
      ]),
      { top: 1 },
    )
    expect(output).toContain("Models (3)")
    expect(output).toContain("p1/a")
    expect(output).toContain("…and 2 more")
    expect(output).not.toContain("p2/b")
  })

  test("hides empty sections and shows a latency placeholder", () => {
    const output = Telemetry.format(Telemetry.summarize([task({ turns: [], userMessages: 2 })]))
    expect(output).toContain("Latency      no completed turns yet")
    expect(output).not.toContain("Models")
    expect(output).not.toContain("Tools (")
    expect(output).not.toContain("Failures")
    expect(output).not.toContain("Retries (")
  })

  test("formats small costs with more precision", () => {
    const output = Telemetry.format(
      Telemetry.summarize([task({ turns: [turn({ cost: 0.0123, created: 0, completed: 1000 })] })]),
    )
    expect(output).toContain("$0.0123 total")
  })
})
