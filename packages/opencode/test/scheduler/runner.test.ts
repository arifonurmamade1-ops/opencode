import { beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Storage } from "@/storage/storage"
import { Scheduler } from "../../src/scheduler/scheduler"
import { SchedulerRunner } from "../../src/scheduler/runner"
import { testEffect } from "../lib/effect"
import { memoryStorage } from "./storage"

type CapturedPrompt = {
  sessionID: string
  agent?: string
  parts: Array<{ type: string; text?: string }>
}

const storage = memoryStorage()
const prompts: CapturedPrompt[] = []
const creates: Array<{ title?: string; agent?: string }> = []
const checkResults: number[] = []

const sessionLayer = Layer.mock(Session.Service, {
  create: (input) =>
    Effect.sync(() => {
      creates.push(input as unknown as { title?: string; agent?: string })
      return { id: "ses_test" } as Session.Info
    }),
})

const promptLayer = Layer.mock(SessionPrompt.Service, {
  prompt: (input) =>
    Effect.sync(() => {
      prompts.push(input as unknown as CapturedPrompt)
      return {} as never
    }),
})

const processLayer = Layer.mock(AppProcess.Service, {
  run: () =>
    Effect.sync(() => ({
      command: "check",
      exitCode: checkResults.shift() ?? 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      stdoutTruncated: false,
      stderrTruncated: false,
    })),
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Scheduler.node, SchedulerRunner.node]), [
    [Storage.node, storage.layer],
    [Session.node, sessionLayer],
    [SessionPrompt.node, promptLayer],
    [AppProcess.node, processLayer],
  ]),
)

beforeEach(() => {
  storage.reset()
  prompts.length = 0
  creates.length = 0
  checkResults.length = 0
})

describe("scheduler runner", () => {
  it.instance("runs due tasks in a fresh session and records the outcome", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const runner = yield* SchedulerRunner.Service
      const task = yield* scheduler.add({
        name: "nightly tests",
        prompt: "Run the tests",
        schedule: { type: "immediate" },
      })

      const report = yield* runner.tick({ now: Date.now() })
      expect(report.started).toBe(1)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.sessionID).toBe("ses_test")
      expect(prompts[0]?.parts).toEqual([{ type: "text", text: "Run the tests" }])
      expect(creates[0]?.title).toBe("scheduled: nightly tests")

      const after = yield* scheduler.get(task.id)
      expect(after?.state.runs).toBe(1)
      expect(after?.state.running).toBe(false)
      expect(after?.state.lastSessionID).toBe("ses_test")
      expect(after?.state.lastResult).toBe("ok")
      expect(after?.enabled).toBe(false)

      const second = yield* runner.tick({ now: Date.now() + 1000 })
      expect(second.started).toBe(0)
      expect(prompts).toHaveLength(1)
    }),
  )

  it.instance("reruns recurring tasks on their schedule", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const runner = yield* SchedulerRunner.Service
      const base = Date.now()
      const task = yield* scheduler.add({ prompt: "ping", schedule: { type: "interval", every: "30m" } })

      expect((yield* runner.tick({ now: base + 31 * 60_000 })).started).toBe(1)
      expect((yield* runner.tick({ now: base + 32 * 60_000 })).started).toBe(0)
      expect((yield* runner.tick({ now: base + 62 * 60_000 })).started).toBe(1)

      const after = yield* scheduler.get(task.id)
      expect(after?.state.runs).toBe(2)
      expect(after?.enabled).toBe(true)
      expect(prompts).toHaveLength(2)
    }),
  )

  it.instance("runs condition tasks only on the transition to matching", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const runner = yield* SchedulerRunner.Service
      const base = Date.now()
      const task = yield* scheduler.add({
        prompt: "investigate",
        schedule: { type: "condition", check: "false", expect: "failure", every: "5m" },
      })

      // First observation matches the condition: this is an edge.
      checkResults.push(1)
      const first = yield* runner.tick({ now: base + 60_000 })
      expect(first.checks).toBe(1)
      expect(first.condition).toBe(1)
      expect(prompts).toHaveLength(1)

      // Still failing on the next check: no new run.
      checkResults.push(1)
      const second = yield* runner.tick({ now: base + 7 * 60_000 })
      expect(second.checks).toBe(1)
      expect(second.condition).toBe(0)
      expect(prompts).toHaveLength(1)

      // Recovered, then failing again: fires again.
      checkResults.push(0)
      const third = yield* runner.tick({ now: base + 13 * 60_000 })
      expect(third.condition).toBe(0)
      checkResults.push(1)
      const fourth = yield* runner.tick({ now: base + 19 * 60_000 })
      expect(fourth.condition).toBe(1)
      expect(prompts).toHaveLength(2)

      const after = yield* scheduler.get(task.id)
      expect(after?.state.lastCheckMatched).toBe(true)
      expect(after?.state.runs).toBe(2)
    }),
  )

  it.instance("does nothing while the scheduler is disabled", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const runner = yield* SchedulerRunner.Service
      yield* scheduler.setSchedulerEnabled(false)
      yield* scheduler.add({ prompt: "x", schedule: { type: "immediate" } })

      const report = yield* runner.tick({ now: Date.now() + 60_000 })
      expect(report).toEqual({ started: 0, checks: 0, condition: 0 })
      expect(prompts).toHaveLength(0)
    }),
  )
})
