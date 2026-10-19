import { describe, expect, test } from "bun:test"
import { BenchmarkReport } from "@/benchmark/report"

function directionOf(name: string): BenchmarkReport.Direction {
  if (name === "duration_ms") return "lower"
  if (name === "notes") return "info"
  return "higher"
}

function runOf(
  id: string,
  label: string,
  metrics: Record<string, number>,
  options?: { samples?: number; caseID?: string; category?: BenchmarkReport.CategoryID },
): BenchmarkReport.Run {
  return {
    id,
    label,
    createdAt: "2026-10-19T00:00:00.000Z",
    durationMs: 100,
    environment: { platform: "test", arch: "test", bun: "0.0.0" },
    cases: [
      {
        id: options?.caseID ?? "coding.apply-edit",
        category: options?.category ?? "coding",
        title: "Apply scripted edits",
        status: "pass",
        samples: options?.samples ?? 1,
        metrics: Object.fromEntries(
          Object.entries(metrics).map(([name, value]) => [name, { value, direction: directionOf(name) }]),
        ),
      },
    ],
  }
}

const caseInfo: BenchmarkReport.CaseInfo = {
  id: "example.case",
  category: "coding",
  title: "Example case",
  description: "Measures an example.",
  metrics: { duration_ms: "lower", ok: "higher" },
}

describe("benchmark.report", () => {
  test("median handles odd and even sample counts", () => {
    expect(BenchmarkReport.median([5])).toBe(5)
    expect(BenchmarkReport.median([10, 30, 20])).toBe(20)
    expect(BenchmarkReport.median([10, 20, 30, 40])).toBe(25)
  })

  test("aggregate uses the median and keeps the best status", () => {
    const sample = (duration: number): BenchmarkReport.CaseResult => ({
      status: "pass",
      metrics: {
        duration_ms: { value: duration, direction: "lower" },
        ok: { value: 1, direction: "higher" },
      },
    })
    const result = BenchmarkReport.aggregate(caseInfo, [sample(30), sample(10), sample(20)])
    expect(result.status).toBe("pass")
    expect(result.samples).toBe(3)
    expect(result.metrics.duration_ms?.value).toBe(20)

    expect(BenchmarkReport.aggregate(caseInfo, [{ status: "fail" }, { status: "pass" }]).status).toBe("pass")
    const unavailableOnly = BenchmarkReport.aggregate(caseInfo, [{ status: "unavailable", detail: "needs a browser" }])
    expect(unavailableOnly.status).toBe("unavailable")
    expect(unavailableOnly.detail).toBe("needs a browser")
  })

  test("compareRuns reports deltas, noise, and missing metrics", () => {
    const comparison = BenchmarkReport.compareRuns(
      runOf("a", "baseline", { duration_ms: 100, ok: 5, notes: 3, extra: 7 }),
      runOf("b", "candidate", { duration_ms: 70, ok: 5, notes: 4, other: 1 }),
    )
    const metrics = new Map(comparison.cases[0]!.metrics.map((item) => [item.metric, item]))
    expect(metrics.get("duration_ms")?.verdict).toBe("better")
    expect(metrics.get("duration_ms")?.delta).toBe(-30)
    expect(metrics.get("ok")?.verdict).toBe("same")
    expect(metrics.get("notes")?.verdict).toBe("informational")
    expect(metrics.get("extra")?.verdict).toBe("missing")
    expect(metrics.get("other")?.verdict).toBe("missing")
    expect(comparison.counts.better).toBe(1)
    expect(comparison.counts.missing).toBe(2)
    expect(comparison.significant).toBe(false)
    expect(comparison.minSamples).toBe(1)
  })

  test("compareRuns applies the noise band and polarity", () => {
    const within = BenchmarkReport.compareRuns(
      runOf("a", "baseline", { duration_ms: 100 }),
      runOf("b", "candidate", { duration_ms: 95 }),
    )
    expect(within.cases[0]!.metrics[0]!.verdict).toBe("within-noise")

    const worse = BenchmarkReport.compareRuns(
      runOf("a", "baseline", { duration_ms: 100 }),
      runOf("b", "candidate", { duration_ms: 150 }),
    )
    expect(worse.cases[0]!.metrics[0]!.verdict).toBe("worse")

    const regression = BenchmarkReport.compareRuns(
      runOf("a", "baseline", { ok: 5 }),
      runOf("b", "candidate", { ok: 1 }),
    )
    expect(regression.cases[0]!.metrics[0]!.verdict).toBe("worse")
  })

  test("compareRuns marks sufficient sample counts significant", () => {
    const comparison = BenchmarkReport.compareRuns(
      runOf("a", "baseline", { ok: 5 }, { samples: 3 }),
      runOf("b", "candidate", { ok: 5 }, { samples: 3 }),
    )
    expect(comparison.significant).toBe(true)
    expect(comparison.minSamples).toBe(3)
  })

  test("compareRuns marks cases missing on one side", () => {
    const comparison = BenchmarkReport.compareRuns(
      runOf("a", "baseline", { ok: 5 }, { caseID: "left.case" }),
      runOf("b", "candidate", { ok: 5 }, { caseID: "right.case" }),
    )
    expect(comparison.cases).toHaveLength(2)
    expect(comparison.cases.find((item) => item.id === "left.case")?.statusB).toBe("missing")
    expect(comparison.cases.find((item) => item.id === "right.case")?.statusA).toBe("missing")
  })

  test("formatRun, formatComparison, and formatCatalog render measurements", () => {
    const run = runOf("a", "baseline", { duration_ms: 100, ok: 5 })
    const text = BenchmarkReport.formatRun(run)
    expect(text).toContain("Benchmark run a (baseline)")
    expect(text).toContain("duration_ms=100")
    expect(text).toContain("[coding] coding.apply-edit — pass")

    const comparison = BenchmarkReport.compareRuns(run, runOf("b", "candidate", { duration_ms: 50, ok: 5 }))
    const comparisonText = BenchmarkReport.formatComparison(comparison)
    expect(comparisonText).toContain("delta is B - A")
    expect(comparisonText).toContain("verdicts:")
    expect(comparisonText).toContain("[better]")

    const catalogText = BenchmarkReport.formatCatalog([caseInfo])
    expect(catalogText).toContain("example.case")
    expect(catalogText).toContain("duration_ms (lower)")
  })
})
