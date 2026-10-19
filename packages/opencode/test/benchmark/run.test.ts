import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Benchmark } from "@/benchmark/benchmark"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

const agentInfo = (
  name: string,
  permission: Agent.Info["permission"],
  mode: Agent.Info["mode"] = "primary",
): Agent.Info => ({ name, mode, permission, options: {} })

const fixtures = [
  agentInfo("build", []),
  agentInfo("plan", [{ permission: "edit", pattern: "*", action: "deny" }]),
  agentInfo("explore", [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "write", pattern: "*", action: "deny" },
  ]),
]

const agentLayer = Layer.mock(Agent.Service, {
  list: () => Effect.succeed(fixtures),
  get: (name) => Effect.succeed(fixtures.find((item) => item.name === name) ?? fixtures[0]!),
})

const providerLayer = Layer.mock(Provider.Service, {
  list: () => Effect.succeed({}),
  defaultModel: () =>
    Effect.sync(() => {
      throw new Error("no providers configured in the benchmark test")
    }),
})

const it = testEffect(
  LayerNode.compile(Benchmark.node, [
    [Agent.node, agentLayer],
    [Provider.node, providerLayer],
  ]),
)

describe("benchmark.service", () => {
  it.instance(
    "runs the full deterministic suite",
    () =>
      Effect.gen(function* () {
        const benchmark = yield* Benchmark.Service
        const catalog = yield* benchmark.catalog()
        expect(catalog).toHaveLength(14)
        expect(new Set(catalog.map((item) => item.category)).size).toBe(12)

        const run = yield* benchmark.run({ label: "full" })
        expect(run.cases).toHaveLength(catalog.length)
        const cases = new Map(run.cases.map((item) => [item.id, item]))

        expect(cases.get("coding.apply-edit")?.status).toBe("pass")
        expect(cases.get("coding.apply-edit")?.metrics.applied?.value).toBe(3)
        expect(cases.get("debugging.locate-fix")?.status).toBe("pass")
        expect(cases.get("debugging.locate-fix")?.metrics.located_top?.value).toBe(1)
        expect(cases.get("refactoring.rename-symbol")?.status).toBe("pass")
        expect(cases.get("refactoring.rename-symbol")?.metrics.stale_refs?.value).toBe(0)
        expect(cases.get("refactoring.rename-symbol")?.metrics.decoy_preserved?.value).toBe(1)
        expect(cases.get("browser.fetch-extract")?.status).toBe("pass")
        expect(cases.get("browser.dom-interaction")?.status).toBe("unavailable")
        expect(cases.get("browser.dom-interaction")?.detail).toContain("browser")
        expect(cases.get("ui.render-surface")?.status).toBe("unavailable")
        expect(cases.get("multi-agent.agent-matrix")?.status).toBe("pass")
        expect(cases.get("long-running.background-job")?.status).toBe("pass")
        expect(cases.get("long-running.background-job")?.metrics.timed_out?.value).toBe(0)
        expect(cases.get("recovery.retry-policy")?.status).toBe("pass")
        expect(cases.get("recovery.retry-policy")?.metrics.classified_ok?.value).toBe(
          cases.get("recovery.retry-policy")?.metrics.classifications?.value,
        )
        expect(cases.get("context.relevance-budget")?.status).toBe("pass")
        expect(cases.get("context.relevance-budget")?.metrics.top1_ok?.value).toBe(1)
        expect(cases.get("security.permission-matrix")?.status).toBe("pass")
        expect(cases.get("security.mcp-policy")?.status).toBe("pass")
        expect(cases.get("routing.model-routing")?.status).toBe("unavailable")
        expect(cases.get("cost.truncate-budget")?.status).toBe("pass")
        expect(cases.get("cost.truncate-budget")?.metrics.truncated?.value).toBe(1)
      }),
    120_000,
  )

  it.instance(
    "persists runs and compares them objectively",
    () =>
      Effect.gen(function* () {
        const benchmark = yield* Benchmark.Service
        const filter = ["coding.apply-edit", "security.permission-matrix"]
        const first = yield* benchmark.run({ label: "baseline", cases: filter })
        const second = yield* benchmark.run({ label: "candidate", cases: filter })
        expect(first.cases).toHaveLength(2)
        expect(second.cases).toHaveLength(2)

        const runs = yield* benchmark.list()
        expect(runs.map((item) => item.id)).toContain(first.id)
        expect(runs.map((item) => item.id)).toContain(second.id)
        expect(runs[0]?.id).toBe(second.id)

        const stored = yield* benchmark.get(second.id)
        expect(stored?.label).toBe("candidate")
        expect(yield* benchmark.get("../../etc/passwd")).toBeUndefined()

        const comparison = yield* benchmark.compare({ a: first.id, b: second.id })
        expect(comparison).toBeDefined()
        expect(comparison?.significant).toBe(false)
        expect(comparison?.counts.missing).toBe(0)
        expect(comparison?.cases.find((item) => item.id === "coding.apply-edit")?.metrics.length).toBeGreaterThan(0)
      }),
    120_000,
  )

  it.instance(
    "records the median of repeated samples",
    () =>
      Effect.gen(function* () {
        const benchmark = yield* Benchmark.Service
        const run = yield* benchmark.run({ cases: ["context.relevance-budget"], repeats: 2 })
        expect(run.cases[0]?.samples).toBe(2)
        expect(run.cases[0]?.status).toBe("pass")
      }),
    60_000,
  )
})
