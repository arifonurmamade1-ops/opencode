import { beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Scheduler } from "../../src/scheduler/scheduler"
import { Storage } from "@/storage/storage"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { memoryStorage } from "./storage"

const storage = memoryStorage()
const it = testEffect(LayerNode.compile(Scheduler.node, [[Storage.node, storage.layer]]))

beforeEach(() => {
  storage.reset()
})

describe("scheduler store", () => {
  it.instance("adds tasks scoped to the current directory", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const test = yield* TestInstance
      const task = yield* scheduler.add({
        name: "nightly tests",
        prompt: "Run the tests",
        schedule: { type: "daily", at: "23:00" },
      })

      expect(task.id.startsWith("tsk_")).toBe(true)
      expect(task.directory).toBe(test.directory)
      expect(task.enabled).toBe(true)
      expect(task.state.nextRunAt).toBeGreaterThan(Date.now())

      const list = yield* scheduler.list()
      expect(list.map((item) => item.id)).toContain(task.id)
      const found = yield* scheduler.get(task.id)
      expect(found?.prompt).toBe("Run the tests")
    }),
  )

  it.instance("rejects malformed schedules", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const message = yield* scheduler
        .add({ prompt: "x", schedule: { type: "interval", every: "5" } })
        .pipe(Effect.catchIf(Scheduler.InvalidSchedule.isInstance, (issue) => Effect.succeed(issue.message)))

      expect(typeof message === "string" ? message : "").toContain("Invalid duration")
    }),
  )

  it.instance("enables, disables and removes tasks", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const task = yield* scheduler.add({ prompt: "x", schedule: { type: "immediate" } })

      const disabled = yield* scheduler.setEnabled({ id: task.id, enabled: false })
      expect(disabled?.enabled).toBe(false)
      const enabled = yield* scheduler.setEnabled({ id: task.id, enabled: true })
      expect(enabled?.enabled).toBe(true)

      expect(yield* scheduler.remove(task.id)).toBe(true)
      expect(yield* scheduler.remove(task.id)).toBe(false)
      expect((yield* scheduler.list()).map((item) => item.id)).not.toContain(task.id)
    }),
  )

  it.instance("claims due tasks and advances recurring schedules", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const base = Date.now()
      const task = yield* scheduler.add({ prompt: "ping", schedule: { type: "interval", every: "30m" } })

      expect(yield* scheduler.claimDue(base)).toEqual([])

      const first = yield* scheduler.claimDue(base + 31 * 60_000)
      expect(first.map((item) => item.id)).toEqual([task.id])
      expect(first[0]?.state.running).toBe(true)
      expect((yield* scheduler.get(task.id))?.state.nextRunAt).toBeGreaterThan(base + 31 * 60_000)

      // While the run is in flight the task is not claimed again.
      expect(yield* scheduler.claimDue(base + 62 * 60_000)).toEqual([])

      yield* scheduler.recordRun({ id: task.id, time: base + 31 * 60_000, sessionID: "ses_test" })
      const recorded = yield* scheduler.get(task.id)
      expect(recorded?.state.runs).toBe(1)
      expect(recorded?.state.running).toBe(false)
      expect(recorded?.state.lastSessionID).toBe("ses_test")
      expect(recorded?.enabled).toBe(true)

      const second = yield* scheduler.claimDue(base + 62 * 60_000)
      expect(second.map((item) => item.id)).toEqual([task.id])
    }),
  )

  it.instance("disables one-shot tasks after they run", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const base = Date.now()
      const task = yield* scheduler.add({ prompt: "once", schedule: { type: "immediate" } })

      expect((yield* scheduler.claimDue(base + 60_000)).map((item) => item.id)).toEqual([task.id])
      yield* scheduler.recordRun({ id: task.id, time: base + 60_000 })
      const after = yield* scheduler.get(task.id)
      expect(after?.enabled).toBe(false)
      expect(after?.state.runs).toBe(1)

      expect(yield* scheduler.claimDue(base + 120_000)).toEqual([])
    }),
  )

  it.instance("queues disabled tasks for a single manual run", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const task = yield* scheduler.add({
        prompt: "manual",
        schedule: { type: "at", time: new Date(Date.now() + 86_400_000).toISOString() },
        enabled: false,
      })

      expect(yield* scheduler.claimDue(Date.now())).toEqual([])
      const queued = yield* scheduler.queue(task.id)
      expect(queued?.state.queued).toBe(true)
      expect((yield* scheduler.claimDue(Date.now() + 1000)).map((item) => item.id)).toEqual([task.id])
    }),
  )

  it.instance("gates claims on the global scheduler toggle", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      expect(yield* scheduler.schedulerEnabled()).toBe(true)
      yield* scheduler.setSchedulerEnabled(false)

      const task = yield* scheduler.add({ prompt: "x", schedule: { type: "immediate" } })
      yield* scheduler.queue(task.id)
      expect(yield* scheduler.claimDue(Date.now() + 60_000)).toEqual([])
      expect(yield* scheduler.claimChecks(Date.now() + 60_000)).toEqual([])

      yield* scheduler.setSchedulerEnabled(true)
      expect((yield* scheduler.claimDue(Date.now() + 60_000)).map((item) => item.id)).toEqual([task.id])
    }),
  )

  it.instance("claims condition checks on their interval", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const base = Date.now()
      const task = yield* scheduler.add({
        prompt: "investigate",
        schedule: { type: "condition", check: "false", expect: "failure", every: "5m" },
      })

      const first = base + 1000
      const checks = yield* scheduler.claimChecks(first)
      expect(checks.map((item) => item.id)).toEqual([task.id])
      expect(yield* scheduler.claimChecks(first + 1000)).toEqual([])

      yield* scheduler.recordCheck({ id: task.id, matched: true, time: first })
      const after = yield* scheduler.get(task.id)
      expect(after?.state.lastCheckMatched).toBe(true)
      expect(after?.state.nextCheckAt).toBe(first + 5 * 60_000)
      expect((yield* scheduler.claimChecks(first + 5 * 60_000)).map((item) => item.id)).toEqual([task.id])
    }),
  )
})
