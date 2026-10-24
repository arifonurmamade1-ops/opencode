import { beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { AgentManager } from "@/agent/manager"
import { testEffect } from "../lib/effect"

type CapturedPrompt = { sessionID: string; agent?: string; parts: Array<{ type: string; text?: string }> }

const prompts: CapturedPrompt[] = []
const creates: Array<{ title?: string }> = []
let promptFailure: Error | undefined
let unknownAgent = false

const agentLayer = Layer.mock(Agent.Service, {
  get: (name: string) =>
    unknownAgent && name === "missing"
      ? Effect.fail(new Error("agent not found"))
      : Effect.succeed({ name, permission: [] } as any),
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
    prompts.push(input as unknown as CapturedPrompt)
    if (promptFailure) return Effect.fail(promptFailure) as never
    return Effect.sync(() => ({ parts: [{ type: "text", text: "done" }] } as any))
  },
})

const it = testEffect(
  LayerNode.compile(AgentManager.node, [
    [Agent.node, agentLayer],
    [Session.node, sessionLayer],
    [SessionPrompt.node, promptLayer],
  ]),
)

beforeEach(() => {
  prompts.length = 0
  creates.length = 0
  promptFailure = undefined
  unknownAgent = false
})

describe("agent manager", () => {
  it.instance("starts a run, creates a session, prompts the agent, and records completion", () =>
    Effect.gen(function* () {
      const manager = yield* AgentManager.Service
      const run = yield* manager.start({ agent: "build", prompt: "do the thing" })

      expect(run.status).toBe("completed")
      expect(run.sessionID).toBe("ses_test")
      expect(run.output).toBe("done")
      expect(run.error).toBeUndefined()
      expect(creates).toHaveLength(1)
      expect(creates[0]?.title).toBe("agent: build")
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.parts).toEqual([{ type: "text", text: "do the thing" }])

      const found = yield* manager.get(run.id)
      expect(found?.status).toBe("completed")
      const all = yield* manager.list()
      expect(all.map((item) => item.id)).toContain(run.id)
    }),
  )

  it.instance("records a failed run when the agent prompt fails", () =>
    Effect.gen(function* () {
      const manager = yield* AgentManager.Service
      promptFailure = new Error("provider exploded")

      const run = yield* manager.start({ agent: "build", prompt: "do the thing" })

      expect(run.status).toBe("failed")
      expect(run.sessionID).toBe("ses_test")
      expect(run.error).toContain("provider exploded")
      expect(run.output).toBeUndefined()
      expect(run.completedAt).toBeDefined()
    }),
  )

  it.instance("runs agents in parallel with runAll and reports per-run outcomes", () =>
    Effect.gen(function* () {
      const manager = yield* AgentManager.Service
      promptFailure = undefined

      const runs = yield* manager.runAll({ agent: "build", prompts: ["one", "two", "three"] })

      expect(runs).toHaveLength(3)
      expect(runs.every((run) => run.status === "completed")).toBe(true)
      expect((yield* manager.list())).toHaveLength(3)
    }),
  )

  it.instance("returns undefined for unknown runs", () =>
    Effect.gen(function* () {
      const manager = yield* AgentManager.Service
      expect(yield* manager.get("run_unknown")).toBeUndefined()
      expect(yield* manager.cancel("run_unknown")).toBeUndefined()
    }),
  )

  it.instance("resolves the agent before creating a session", () =>
    Effect.gen(function* () {
      const manager = yield* AgentManager.Service
      unknownAgent = true

      const error = yield* manager.start({ agent: "missing", prompt: "x" }).pipe(Effect.flip)
      expect(error.message).toContain("agent not found")
      expect(creates).toHaveLength(0)
      expect(prompts).toHaveLength(0)
    }),
  )

  it.instance("runForTask carries the task id through the run", () =>
    Effect.gen(function* () {
      const manager = yield* AgentManager.Service
      const run = yield* manager.runForTask({ agent: "build", taskID: "tsk_1", objective: "ship it" })

      expect(run.taskID).toBe("tsk_1")
      expect(run.status).toBe("completed")
      expect(prompts[0]?.parts).toEqual([{ type: "text", text: "ship it" }])
    }),
  )
})
