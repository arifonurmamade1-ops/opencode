import { beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Orchestration } from "@/orchestration"
import { testEffect } from "./lib/effect"

const prompts: Array<{ sessionID: string; agent?: string }> = []
const creates: Array<{ title?: string }> = []
let promptFailureFor: string | undefined

const agentLayer = Layer.mock(Agent.Service, {
  get: (name: string) => Effect.succeed({ name, permission: [] } as any),
})

const sessionLayer = Layer.mock(Session.Service, {
  create: (input) =>
    Effect.sync(() => {
      creates.push(input as unknown as { title?: string })
      return { id: "ses_test" } as Session.Info
    }),
})

const promptLayer = Layer.mock(SessionPrompt.Service, {
  prompt: (input) => {
    prompts.push(input as unknown as { sessionID: string; agent?: string })
    if (promptFailureFor && input.agent === promptFailureFor) return Effect.fail(new Error(`${promptFailureFor} exploded`)) as never
    return Effect.sync(() => ({ parts: [{ type: "text", text: "ok" }] } as any))
  },
})

const it = testEffect(
  LayerNode.compile(Orchestration.node, [
    [Agent.node, agentLayer],
    [Session.node, sessionLayer],
    [SessionPrompt.node, promptLayer],
  ]),
)

beforeEach(() => {
  prompts.length = 0
  creates.length = 0
  promptFailureFor = undefined
})

describe("orchestration", () => {
  it.instance("runs steps in dependency order", () =>
    Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service
      const plan = {
        steps: [
          { id: "a", agent: "build", prompt: "first" },
          { id: "b", agent: "build", prompt: "second", dependsOn: ["a"] },
        ],
      }
      const run = yield* orchestration.start(plan)

      expect(run.status).toBe("completed")
      expect(Object.keys(run.results).sort()).toEqual(["a", "b"])
      expect(run.results.a?.status).toBe("completed")
      expect(run.results.b?.status).toBe("completed")
      expect(prompts.map((p) => p.sessionID)).toHaveLength(2)
    }),
  )

  it.instance("fan-out runs independent steps together", () =>
    Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service
      const run = yield* orchestration.start({
        steps: [
          { id: "a", agent: "build", prompt: "one" },
          { id: "b", agent: "build", prompt: "two" },
        ],
      })

      expect(run.status).toBe("completed")
      expect(run.results.a?.status).toBe("completed")
      expect(run.results.b?.status).toBe("completed")
      expect(creates).toHaveLength(2)
    }),
  )

  it.instance("fan-in waits for all dependencies", () =>
    Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service
      const run = yield* orchestration.start({
        steps: [
          { id: "a", agent: "build", prompt: "one" },
          { id: "b", agent: "build", prompt: "two" },
          { id: "c", agent: "build", prompt: "three", dependsOn: ["a", "b"] },
        ],
      })

      expect(run.status).toBe("completed")
      expect(Object.keys(run.results).sort()).toEqual(["a", "b", "c"])
      expect(run.results.c?.status).toBe("completed")
    }),
  )

  it.instance("skips dependents when a dependency fails", () =>
    Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service
      promptFailureFor = "failing-agent"
      const run = yield* orchestration.start({
        steps: [
          { id: "a", agent: "failing-agent", prompt: "boom" },
          { id: "b", agent: "build", prompt: "never runs", dependsOn: ["a"] },
          { id: "c", agent: "build", prompt: "independent" },
        ],
      })

      expect(run.status).toBe("failed")
      expect(run.results.a?.status).toBe("failed")
      expect(run.results.b?.status).toBe("skipped")
      expect(run.results.c?.status).toBe("completed")
    }),
  )

  it.instance("rejects invalid plans", () =>
    Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service

      const cycle = yield* orchestration.start({
        steps: [
          { id: "a", agent: "build", prompt: "x", dependsOn: ["b"] },
          { id: "b", agent: "build", prompt: "y", dependsOn: ["a"] },
        ],
      }).pipe(Effect.flip)
      expect(cycle.message).toContain("cycle")

      const unknown = yield* orchestration.start({
        steps: [{ id: "a", agent: "build", prompt: "x", dependsOn: ["ghost"] }],
      }).pipe(Effect.flip)
      expect(unknown.message).toContain("unknown")

      const dup = yield* orchestration.start({
        steps: [
          { id: "a", agent: "build", prompt: "x" },
          { id: "a", agent: "build", prompt: "y" },
        ],
      }).pipe(Effect.flip)
      expect(dup.message).toContain("duplicate")

      const self = yield* orchestration.start({
        steps: [{ id: "a", agent: "build", prompt: "x", dependsOn: ["a"] }],
      }).pipe(Effect.flip)
      expect(self.message).toContain("itself")
    }),
  )

  it.instance("returns undefined for unknown runs", () =>
    Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service
      expect(yield* orchestration.get("orc_unknown")).toBeUndefined()
      expect(yield* orchestration.cancel("orc_unknown")).toBeUndefined()
    }),
  )

  it.instance("cancel after completion returns the run unchanged", () =>
    Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service
      const run = yield* orchestration.start({
        steps: [{ id: "a", agent: "build", prompt: "one" }],
      })
      expect(run.status).toBe("completed")
      const cancelled = yield* orchestration.cancel(run.id)
      expect(cancelled?.status).toBe("completed")
    }),
  )

  it.instance("records each run in list", () =>
    Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service
      yield* orchestration.start({ steps: [{ id: "a", agent: "build", prompt: "one" }] })
      yield* orchestration.start({ steps: [{ id: "b", agent: "build", prompt: "two" }] })
      const list = yield* orchestration.list()
      expect(list).toHaveLength(2)
    }),
  )
})
