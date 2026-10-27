import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Identifier } from "@/id/id"
import { AgentManager } from "@/agent/manager"
import { InstanceState } from "@/effect/instance-state"
import { Schema } from "effect"
import { Cause, Context, Effect, Exit, Layer } from "effect"

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled"

export type Step = {
  readonly id: string
  readonly agent: string
  readonly prompt: string
  readonly dependsOn?: readonly string[]
}

export type Plan = {
  readonly steps: readonly Step[]
}

export type StepResult = {
  readonly id: string
  readonly agent: string
  readonly status: StepStatus
  readonly sessionID?: string
  readonly output?: string
  readonly error?: string
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled"

export type RunInfo = {
  readonly id: string
  readonly status: RunStatus
  readonly startedAt: number
  readonly completedAt?: number
  readonly results: Record<string, StepResult>
  readonly error?: string
}

export class InvalidPlanError extends Schema.TaggedErrorClass<InvalidPlanError>()("Orchestration.InvalidPlan", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail
  }
}

export interface Interface {
  readonly start: (plan: Plan) => Effect.Effect<RunInfo, InvalidPlanError>
  readonly get: (id: string) => Effect.Effect<RunInfo | undefined>
  readonly list: () => Effect.Effect<RunInfo[]>
  readonly cancel: (id: string) => Effect.Effect<RunInfo | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Orchestration") {}

function validate(plan: Plan): string | undefined {
  const ids = plan.steps.map((s) => s.id)
  if (new Set(ids).size !== ids.length) return "duplicate step id"
  const idSet = new Set(ids)
  for (const step of plan.steps) {
    const seen = new Set<string>()
    for (const dep of step.dependsOn ?? []) {
      if (!idSet.has(dep)) return `step "${step.id}" depends on unknown step "${dep}"`
      if (dep === step.id) return `step "${step.id}" depends on itself`
      if (seen.has(dep)) return `step "${step.id}" lists dependency "${dep}" more than once`
      seen.add(dep)
    }
  }
  // cycle detection (Kahn)
  const inDegree = new Map(ids.map((id) => [id, 0]))
  for (const step of plan.steps) inDegree.set(step.id, step.dependsOn?.length ?? 0)
  const queue = ids.filter((id) => (inDegree.get(id) ?? 0) === 0)
  let visited = 0
  while (queue.length > 0) {
    const cur = queue.shift()!
    visited++
    for (const step of plan.steps) {
      if (step.dependsOn?.includes(cur)) {
        const d = (inDegree.get(step.id) ?? 0) - 1
        inDegree.set(step.id, d)
        if (d === 0) queue.push(step.id)
      }
    }
  }
  if (visited !== ids.length) return "plan contains a dependency cycle"
  return undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const manager = yield* AgentManager.Service
    const state = yield* InstanceState.make<Record<string, RunInfo>>(() => Effect.succeed({}))

    const start = Effect.fn("Orchestration.start")(function* (plan: Plan) {
      const problem = validate(plan)
      if (problem) return yield* new InvalidPlanError({ detail: problem })

      const id = Identifier.create("orc", "descending")
      const startedAt = Date.now()
      const results: Record<string, StepResult> = {}
      const run: RunInfo = { id, status: "running", startedAt, results: {} }
      const map = yield* InstanceState.get(state)
      map[id] = run

      const depsOf = (sid: string) => plan.steps.find((s) => s.id === sid)?.dependsOn ?? []

      const runnable = (): Step[] =>
        plan.steps.filter((s) => {
          if (results[s.id]) return false
          const deps = depsOf(s.id)
          return deps.every((d) => results[d] !== undefined)
        })

      const blockedByFailedDep = (sid: string): boolean => {
        const deps = depsOf(sid)
        return deps.some((d) => results[d]?.status === "failed" || results[d]?.status === "skipped" || results[d]?.status === "cancelled")
      }

      let wasCancelled = false

      while (Object.keys(results).length < plan.steps.length) {
          const current = map[id]
          if (current?.status === "cancelled") {
            wasCancelled = true
            for (const s of plan.steps) {
              if (!results[s.id]) results[s.id] = { id: s.id, agent: s.agent, status: "cancelled" }
            }
            break
          }

          // Skip steps whose dependency failed/cancelled.
          const toSkip = plan.steps.filter((s) => !results[s.id] && blockedByFailedDep(s.id))
          if (toSkip.length > 0) {
            for (const s of toSkip) results[s.id] = { id: s.id, agent: s.agent, status: "skipped", error: "dependency did not complete successfully" }
            continue
          }

          const ready = runnable()
          if (ready.length === 0) {
            // Should not happen after cycle validation; guard anyway.
            for (const s of plan.steps) {
              if (!results[s.id]) results[s.id] = { id: s.id, agent: s.agent, status: "skipped", error: "unreachable" }
            }
            break
          }

          const waveResults = yield* Effect.forEach(
            ready,
            (step) =>
              Effect.gen(function* () {
                const run = yield* Effect.exit(manager.start({ agent: step.agent, prompt: step.prompt }))
                if (Exit.isSuccess(run)) {
                  const r = run.value
                  return {
                    id: step.id,
                    agent: step.agent,
                    status: (r.status === "completed" ? "completed" : r.status === "failed" ? "failed" : r.status) as StepStatus,
                    sessionID: r.sessionID,
                    output: r.output,
                    error: r.error,
                  } satisfies StepResult
                }
                return { id: step.id, agent: step.agent, status: "failed" as StepStatus, error: Cause.pretty(run.cause) } satisfies StepResult
              }),
            { concurrency: "unbounded" },
          )

          for (const r of waveResults) results[r.id] = r
        }

      const anyFailed = Object.values(results).some((r) => r.status === "failed")
      const finalStatus: RunStatus = wasCancelled ? "cancelled" : anyFailed ? "failed" : "completed"
      const completedAt = Date.now()
      const finalRun: RunInfo = { id, status: finalStatus, startedAt, completedAt, results: { ...results }, ...(anyFailed ? { error: "one or more steps failed" } : {}) }
      map[id] = finalRun
      return finalRun
    })

    const get = Effect.fn("Orchestration.get")(function* (id: string) {
      const map = yield* InstanceState.get(state)
      return map[id]
    })

    const list = Effect.fn("Orchestration.list")(function* () {
      const map = yield* InstanceState.get(state)
      return Object.values(map).sort((a, b) => b.startedAt - a.startedAt)
    })

    const cancel = Effect.fn("Orchestration.cancel")(function* (id: string) {
      const map = yield* InstanceState.get(state)
      const run = map[id]
      if (!run) return undefined
      // In-flight steps (AgentManager runs inline) cannot be aborted mid-flight;
      // cancellation takes effect between waves (already-completed waves stay).
      // Record the intent; if still running, mark cancelled for any not-yet-started steps.
      if (run.status === "running") {
        map[id] = { ...run, status: "cancelled", completedAt: Date.now(), error: "cancelled" }
      }
      return map[id]
    })

    return Service.of({ start, get, list, cancel })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [AgentManager.node],
})

export * as Orchestration from "./orchestration"
