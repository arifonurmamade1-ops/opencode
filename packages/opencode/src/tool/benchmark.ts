import { Effect, Schema } from "effect"
import { Benchmark } from "@/benchmark/benchmark"
import { BenchmarkReport } from "@/benchmark/report"
import DESCRIPTION from "./benchmark.txt"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["run", "cases", "runs", "show", "compare"])
    .annotate({
      description:
        "run executes the suite and stores the result; cases lists the catalog; runs lists stored runs; show prints one run; compare prints the delta between two runs.",
      default: "run",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("run" as const))),
  label: Schema.optional(Schema.String).annotate({
    description: "Optional name for a new run (action run).",
  }),
  cases: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Filter cases by id or category (action run). Defaults to every case.",
  }),
  repeats: Schema.optional(Schema.Number).annotate({
    description: "Repeat each case 1-5 times and record the median (action run). Defaults to 1.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Run id for action show. Defaults to the most recent run.",
  }),
  a: Schema.optional(Schema.String).annotate({
    description: "Baseline run id for action compare. Defaults to the second most recent run.",
  }),
  b: Schema.optional(Schema.String).annotate({
    description: "Candidate run id for action compare. Defaults to the most recent run.",
  }),
})

type Metadata = {
  action: string
  cases: number
  pass: number
  fail: number
  unavailable: number
  error: number
  runs: number
}

export const BenchmarkTool = Tool.define<typeof Parameters, Metadata, Benchmark.Service>(
  "benchmark",
  Effect.gen(function* () {
    const benchmark = yield* Benchmark.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          if (params.action === "cases") {
            const catalog = yield* benchmark.catalog()
            return {
              title: `${catalog.length} benchmark cases`,
              output: BenchmarkReport.formatCatalog(catalog),
              metadata: empty("cases"),
            }
          }

          if (params.action === "runs") {
            const runs = yield* benchmark.list()
            return {
              title: `${runs.length} benchmark run(s)`,
              output: BenchmarkReport.formatRuns(runs),
              metadata: { ...empty("runs"), runs: runs.length },
            }
          }

          if (params.action === "show") {
            const runs = yield* benchmark.list()
            const id = params.id ?? runs[0]?.id
            if (id === undefined) {
              return {
                title: "No benchmark runs",
                output: "No benchmark runs recorded yet. Use action run first.",
                metadata: empty("show"),
              }
            }
            const run = yield* benchmark.get(id)
            if (run === undefined) {
              return {
                title: `Unknown benchmark run ${id}`,
                output: `No stored benchmark run with id "${id}".`,
                metadata: empty("show"),
              }
            }
            const summary = BenchmarkReport.summarizeRun(run)
            return {
              title: `Benchmark run ${run.id}`,
              output: BenchmarkReport.formatRun(run),
              metadata: metadataOf("show", summary),
            }
          }

          if (params.action === "compare") {
            const comparison = yield* benchmark.compare({ a: params.a, b: params.b })
            if (comparison === undefined) {
              return {
                title: "Not enough runs to compare",
                output: "Record at least two benchmark runs before comparing.",
                metadata: empty("compare"),
              }
            }
            return {
              title: `Benchmark comparison ${comparison.a.id} vs ${comparison.b.id}`,
              output: BenchmarkReport.formatComparison(comparison),
              metadata: empty("compare"),
            }
          }

          const run = yield* benchmark.run({ label: params.label, cases: params.cases, repeats: params.repeats })
          const summary = BenchmarkReport.summarizeRun(run)
          return {
            title: `Benchmark run ${run.id} — ${summary.pass}/${summary.total} pass`,
            output: BenchmarkReport.formatRun(run),
            metadata: metadataOf("run", summary),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function empty(action: string): Metadata {
  return { action, cases: 0, pass: 0, fail: 0, unavailable: 0, error: 0, runs: 0 }
}

function metadataOf(action: string, summary: BenchmarkReport.RunSummary): Metadata {
  return {
    action,
    cases: summary.total,
    pass: summary.pass,
    fail: summary.fail,
    unavailable: summary.unavailable,
    error: summary.error,
    runs: 1,
  }
}
