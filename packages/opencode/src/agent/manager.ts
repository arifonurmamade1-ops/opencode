import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Identifier } from "@/id/id"
import { InstanceState } from "@/effect/instance-state"
import { Agent } from "./agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Cause, Context, Effect, Exit, Layer } from "effect"

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

export type RunInfo = {
  id: string
  agent: string
  taskID?: string
  sessionID?: string
  status: RunStatus
  prompt: string
  startedAt: number
  completedAt?: number
  output?: string
  error?: string
}

export interface Interface {
  readonly start: (input: { agent: string; prompt: string; taskID?: string }) => Effect.Effect<RunInfo>
  readonly list: () => Effect.Effect<RunInfo[]>
  readonly get: (id: string) => Effect.Effect<RunInfo | undefined>
  readonly cancel: (id: string) => Effect.Effect<RunInfo | undefined>
  readonly runAll: (input: { agent: string; prompts: readonly string[] }) => Effect.Effect<RunInfo[]>
  readonly runForTask: (input: { agent: string; taskID: string; objective: string }) => Effect.Effect<RunInfo>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentManager") {}

const MAX_OUTPUT = 500

function summarizeOutput(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const text = parts
    .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("")
    .trim()
  if (!text) return undefined
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}...` : text
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service

    const state = yield* InstanceState.make<Record<string, RunInfo>>(() => Effect.succeed({}))

    const start = Effect.fn("AgentManager.start")(function* (input: { agent: string; prompt: string; taskID?: string }) {
      // Resolve the agent up front so an unknown agent fails before any session is created.
      // `Agent.get` is typed as returning `Info` but yields `undefined` for unknown names today.
      const agent = yield* agents.get(input.agent)
      if (!agent) return yield* Effect.die(new Error(`agent not found: ${input.agent}`))

      const id = Identifier.create("run", "descending")
      const startedAt = Date.now()
      const initial: RunInfo = {
        id,
        agent: input.agent,
        taskID: input.taskID,
        status: "running",
        prompt: input.prompt,
        startedAt,
      }
      const map = yield* InstanceState.get(state)
      map[id] = initial

      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const session = yield* sessions.create({
            title: `agent: ${input.agent}`,
          })
          map[id]!.sessionID = session.id
          const result = yield* prompts.prompt({
            sessionID: session.id,
            agent: input.agent,
            parts: [{ type: "text", text: input.prompt }],
          })
          return result
        }),
      )

      const completedAt = Date.now()
      if (Exit.isSuccess(outcome)) {
        map[id] = {
          ...map[id]!,
          status: "completed",
          completedAt,
          output: summarizeOutput(outcome.value?.parts) ?? "completed",
        }
      } else {
        map[id] = {
          ...map[id]!,
          status: "failed",
          completedAt,
          error: Cause.pretty(outcome.cause),
        }
      }
      return map[id]!
    })

    const list = Effect.fn("AgentManager.list")(function* () {
      const map = yield* InstanceState.get(state)
      return Object.values(map).sort((a, b) => b.startedAt - a.startedAt)
    })

    const get = Effect.fn("AgentManager.get")(function* (id: string) {
      const map = yield* InstanceState.get(state)
      return map[id]
    })

    const cancel = Effect.fn("AgentManager.cancel")(function* (id: string) {
      const map = yield* InstanceState.get(state)
      const run = map[id]
      if (!run) return undefined
      // Runs are awaited inline today, so cancellation only flips runs that
      // have not yet started (none in practice). Forked, cancellable runs are
      // a documented follow-up (see FASE 39 PHASE 2 limitations).
      if (run.status === "pending" || run.status === "running") {
        map[id] = { ...run, status: "cancelled", completedAt: Date.now() }
      }
      return map[id]
    })

    const runAll = Effect.fn("AgentManager.runAll")(function* (input: { agent: string; prompts: readonly string[] }) {
      return yield* Effect.forEach(
        input.prompts,
        (prompt) => start({ agent: input.agent, prompt }),
        { concurrency: "unbounded" },
      )
    })

    const runForTask = Effect.fn("AgentManager.runForTask")(function* (input: { agent: string; taskID: string; objective: string }) {
      return yield* start({ agent: input.agent, prompt: input.objective, taskID: input.taskID })
    })

    return Service.of({ start, list, get, cancel, runAll, runForTask })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Session.node, SessionPrompt.node],
})

export * as AgentManager from "./manager"
