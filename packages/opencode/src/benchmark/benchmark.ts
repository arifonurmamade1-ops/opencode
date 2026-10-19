/**
 * Internal benchmark service — FASE 30.
 *
 * Runs the deterministic case suite in-process, persists every run as JSON
 * under the global data directory, and compares two runs objectively. No case
 * calls a model, so repeated runs stay cheap and reproducible.
 */

import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Cause, Clock, Context, Effect, Exit, Layer } from "effect"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "@/tool/webfetch"
import { Cases } from "./cases"
import { BenchmarkReport } from "./report"

export type RunInput = {
  readonly label?: string
  readonly cases?: readonly string[]
  readonly repeats?: number
}

export type CompareInput = {
  readonly a?: string
  readonly b?: string
}

export interface Interface {
  /** Static case catalog: ids, categories, metrics, and what each case measures. */
  readonly catalog: () => Effect.Effect<readonly BenchmarkReport.CaseInfo[]>
  /** Executes the selected cases and persists the run. */
  readonly run: (input?: RunInput) => Effect.Effect<BenchmarkReport.Run>
  /** Stored runs, newest first. */
  readonly list: () => Effect.Effect<readonly BenchmarkReport.RunSummary[]>
  readonly get: (id: string) => Effect.Effect<BenchmarkReport.Run | undefined>
  /** Compares two runs (defaults to the two most recent). */
  readonly compare: (input?: CompareInput) => Effect.Effect<BenchmarkReport.Comparison | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Benchmark") {}

const MAX_REPEATS = 5
const CASE_TIMEOUT_MS = 60_000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const truncate = yield* Truncate.Service
    const agents = yield* Agent.Service
    const providers = yield* Provider.Service
    const webFetchInfo = yield* WebFetchTool
    const deps: Cases.CaseDeps = {
      fs,
      truncate,
      agents,
      providers,
      webfetch: yield* Tool.init(webFetchInfo),
    }
    const store = path.join(Global.Path.data, "benchmark", "runs")

    const catalog: Interface["catalog"] = () =>
      Effect.succeed(
        Cases.CASES.map(
          (item): BenchmarkReport.CaseInfo => ({
            id: item.id,
            category: item.category,
            title: item.title,
            description: item.description,
            metrics: item.metrics,
          }),
        ),
      )

    const list: Interface["list"] = Effect.fn("Benchmark.list")(function* () {
      const entries = yield* fs
        .readDirectoryEntries(store)
        .pipe(Effect.catch(() => Effect.succeed([] as FSUtil.DirEntry[])))
      const runs: BenchmarkReport.RunSummary[] = []
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".json")) continue
        const value = yield* fs
          .readJson(path.join(store, entry.name))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        const record = asRun(value)
        if (record !== undefined) runs.push(BenchmarkReport.summarizeRun(record))
      }
      return runs.toSorted((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    })

    const get: Interface["get"] = Effect.fn("Benchmark.get")(function* (id: string) {
      if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes("..")) return undefined
      const value = yield* fs
        .readJson(path.join(store, `${id}.json`))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      return asRun(value)
    })

    const run: Interface["run"] = Effect.fn("Benchmark.run")(function* (input?: RunInput) {
      const repeats = Math.max(1, Math.min(MAX_REPEATS, Math.floor(input?.repeats ?? 1)))
      const selected = Cases.select(input?.cases)
      const started = yield* Clock.currentTimeMillis
      const cases: BenchmarkReport.RunCase[] = []
      for (const definition of selected) {
        const results: BenchmarkReport.CaseResult[] = []
        for (let index = 0; index < repeats; index++) {
          const outcome = yield* definition.run(deps).pipe(
            Effect.timeoutOrElse({
              duration: CASE_TIMEOUT_MS,
              orElse: () =>
                Effect.succeed<BenchmarkReport.CaseResult>({
                  status: "error",
                  detail: `case timed out after ${CASE_TIMEOUT_MS}ms`,
                }),
            }),
            Effect.exit,
          )
          if (Exit.isFailure(outcome)) {
            results.push({ status: "error", detail: messageOf(Cause.squash(outcome.cause)) })
            break
          }
          results.push(outcome.value)
          if (outcome.value.status === "unavailable" || outcome.value.status === "error") break
        }
        cases.push(BenchmarkReport.aggregate(definition, results))
      }

      const now = yield* Clock.currentTimeMillis
      const record: BenchmarkReport.Run = {
        id: `${now}-${slug(input?.label)}`,
        ...(input?.label !== undefined ? { label: input.label } : {}),
        createdAt: new Date(now).toISOString(),
        durationMs: Math.round(now - started),
        environment: {
          platform: process.platform,
          arch: process.arch,
          bun: process.versions.bun ?? "unknown",
        },
        cases,
      }
      yield* fs.ensureDir(store).pipe(Effect.orDie)
      yield* fs.writeJson(path.join(store, `${record.id}.json`), record).pipe(Effect.orDie)
      return record
    })

    const compare: Interface["compare"] = Effect.fn("Benchmark.compare")(function* (input?: CompareInput) {
      const summaries = yield* list()
      const ids = summaries.map((item) => item.id)
      const pair = resolvePair(ids, input)
      if (pair[0] === undefined || pair[1] === undefined || pair[0] === pair[1]) return undefined
      const left = yield* get(pair[0])
      const right = yield* get(pair[1])
      if (left === undefined || right === undefined) return undefined
      return BenchmarkReport.compareRuns(left, right)
    })

    return Service.of({ catalog, run, list, get, compare })
  }),
)

function resolvePair(ids: readonly string[], input?: CompareInput): readonly [string | undefined, string | undefined] {
  if (input?.a !== undefined && input.b !== undefined) return [input.a, input.b]
  if (input?.a !== undefined) return [input.a, ids.find((id) => id !== input.a)]
  if (input?.b !== undefined) return [ids.find((id) => id !== input.b), input.b]
  return [ids[1], ids[0]]
}

function asRun(value: unknown): BenchmarkReport.Run | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || typeof record.createdAt !== "string" || !Array.isArray(record.cases)) {
    return undefined
  }
  return value as BenchmarkReport.Run
}

function slug(label?: string): string {
  const text = (label ?? "run")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return text.length > 0 ? text : "run"
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [FSUtil.node, Truncate.node, Agent.node, Provider.node, httpClient],
})

export * as Benchmark from "./benchmark"
