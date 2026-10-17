import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { Storage } from "../storage/storage"
import { Schedule } from "./schedule"

/**
 * Durable task store for the scheduler.
 *
 * Tasks are scoped to the directory that created them. The store only performs
 * state transitions; executing a task is the runner's job, which keeps this
 * service free of Session dependencies and lets the schedule tool depend on it
 * without creating a layer cycle.
 */

export const ScheduleSpec = Schema.Union([
  Schema.Struct({ type: Schema.Literal("immediate") }),
  Schema.Struct({ type: Schema.Literal("at"), time: Schema.String }),
  Schema.Struct({ type: Schema.Literal("interval"), every: Schema.String }),
  Schema.Struct({ type: Schema.Literal("daily"), at: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cron"), expression: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("condition"),
    check: Schema.String,
    expect: Schema.optional(Schema.Literals(["success", "failure"])),
    every: Schema.optional(Schema.String),
  }),
]).annotate({ discriminator: "type" })
export type ScheduleSpec = Schema.Schema.Type<typeof ScheduleSpec>

export const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})
export type ModelRef = Schema.Schema.Type<typeof ModelRef>

export type TaskState = {
  running?: boolean
  runningSince?: number
  queued?: boolean
  nextRunAt?: number
  lastRunAt?: number
  lastResult?: string
  lastSessionID?: string
  runs: number
  lastCheckAt?: number
  lastCheckMatched?: boolean
  nextCheckAt?: number
}

export type Info = {
  id: string
  name?: string
  prompt: string
  schedule: ScheduleSpec
  enabled: boolean
  agent?: string
  model?: ModelRef
  directory: string
  worktree: string
  time: { created: number }
  state: TaskState
}

export type AddInput = {
  name?: string
  prompt: string
  schedule: ScheduleSpec
  enabled?: boolean
  agent?: string
  model?: ModelRef
}

export class InvalidSchedule extends Schema.TaggedErrorClass<InvalidSchedule>()("SchedulerInvalidSchedule", {
  message: Schema.String,
}) {
  static isInstance(input: unknown): input is InvalidSchedule {
    return input instanceof InvalidSchedule
  }
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly add: (input: AddInput) => Effect.Effect<Info, InvalidSchedule>
  readonly remove: (id: string) => Effect.Effect<boolean>
  readonly setEnabled: (input: { id: string; enabled: boolean }) => Effect.Effect<Info | undefined>
  readonly setSchedulerEnabled: (enabled: boolean) => Effect.Effect<void>
  readonly schedulerEnabled: () => Effect.Effect<boolean>
  /** Marks a task to run on the next tick, even when it is disabled. */
  readonly queue: (id: string) => Effect.Effect<Info | undefined>
  readonly claimDue: (now: number) => Effect.Effect<Info[]>
  readonly claimRun: (input: { id: string; now: number }) => Effect.Effect<Info | undefined>
  readonly claimChecks: (now: number) => Effect.Effect<Info[]>
  readonly recordRun: (input: {
    id: string
    sessionID?: string
    error?: string
    time: number
  }) => Effect.Effect<void>
  readonly recordCheck: (input: { id: string; matched: boolean; time: number }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Scheduler") {}

const TASKS_KEY = ["scheduler", "tasks"]
const SETTINGS_KEY = ["scheduler", "settings"]

// A run that never reported back (crash, hard kill) must not block the task
// forever, so stale running markers are ignored after an hour.
const STALE_RUNNING = 60 * 60 * 1000
const MAX_RESULT_LENGTH = 500

type Store = { tasks: Info[] }
type Settings = { enabled?: boolean }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service

    const readStore = storage.read<Store>(TASKS_KEY).pipe(
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed<Store>({ tasks: [] })),
      Effect.orDie,
    )

    const readSettings = storage.read<Settings>(SETTINGS_KEY).pipe(
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed<Settings>({})),
      Effect.orDie,
    )

    const mutate = <A>(apply: (store: Store) => A): Effect.Effect<A> => {
      let output = undefined as A
      const run = (store: Store) => {
        output = apply(store)
      }
      return storage.update<Store>(TASKS_KEY, run).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () =>
          Effect.gen(function* () {
            const store: Store = { tasks: [] }
            run(store)
            yield* storage.write(TASKS_KEY, store)
          }),
        ),
        Effect.map(() => output),
        Effect.orDie,
      )
    }

    const own = (store: Store, directory: string) => store.tasks.filter((task) => task.directory === directory)

    const running = (task: Info, now: number) =>
      task.state.running === true && now - (task.state.runningSince ?? 0) < STALE_RUNNING

    const summarize = (value: string) =>
      value.length > MAX_RESULT_LENGTH ? `${value.slice(0, MAX_RESULT_LENGTH)}...` : value

    const list = Effect.fn("Scheduler.list")(function* () {
      const directory = yield* InstanceState.directory
      const store = yield* readStore
      return own(store, directory).sort((a, b) => a.time.created - b.time.created)
    })

    const get = Effect.fn("Scheduler.get")(function* (id: string) {
      const directory = yield* InstanceState.directory
      const store = yield* readStore
      return own(store, directory).find((task) => task.id === id)
    })

    const add = Effect.fn("Scheduler.add")(function* (input: AddInput) {
      const issue = Schedule.validateSpec(input.schedule)
      if (issue) return yield* new InvalidSchedule({ message: issue })
      if (!input.prompt.trim()) return yield* new InvalidSchedule({ message: "The task prompt cannot be empty." })
      const context = yield* InstanceState.context
      const now = Date.now()
      const task: Info = {
        id: Identifier.create("tsk", "descending"),
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        enabled: input.enabled ?? true,
        agent: input.agent,
        model: input.model,
        directory: context.directory,
        worktree: context.worktree,
        time: { created: now },
        state:
          input.schedule.type === "condition"
            ? { runs: 0, nextCheckAt: now }
            : { runs: 0, nextRunAt: Schedule.nextRunAt(input.schedule, now) },
      }
      yield* mutate((store) => {
        store.tasks.push(task)
      })
      return task
    })

    const remove = Effect.fn("Scheduler.remove")(function* (id: string) {
      const directory = yield* InstanceState.directory
      return yield* mutate((store) => {
        const index = store.tasks.findIndex((task) => task.id === id && task.directory === directory)
        if (index === -1) return false
        store.tasks.splice(index, 1)
        return true
      })
    })

    const setEnabled = Effect.fn("Scheduler.setEnabled")(function* (input: { id: string; enabled: boolean }) {
      const directory = yield* InstanceState.directory
      return yield* mutate((store) => {
        const task = store.tasks.find((candidate) => candidate.id === input.id && candidate.directory === directory)
        if (!task) return undefined
        task.enabled = input.enabled
        return structuredClone(task)
      })
    })

    const setSchedulerEnabled = Effect.fn("Scheduler.setSchedulerEnabled")(function* (enabled: boolean) {
      yield* storage.write(SETTINGS_KEY, { enabled }).pipe(Effect.orDie)
    })

    const schedulerEnabled = Effect.fn("Scheduler.schedulerEnabled")(function* () {
      const settings = yield* readSettings
      return settings.enabled ?? true
    })

    const queue = Effect.fn("Scheduler.queue")(function* (id: string) {
      const directory = yield* InstanceState.directory
      const now = Date.now()
      return yield* mutate((store) => {
        const task = store.tasks.find((candidate) => candidate.id === id && candidate.directory === directory)
        if (!task) return undefined
        task.state.queued = true
        task.state.nextRunAt = Math.min(task.state.nextRunAt ?? now, now)
        return structuredClone(task)
      })
    })

    const claimDue = Effect.fn("Scheduler.claimDue")(function* (now: number) {
      const directory = yield* InstanceState.directory
      if (!(yield* schedulerEnabled())) return [] as Info[]
      return yield* mutate((store) => {
        const claimed: Info[] = []
        for (const task of store.tasks) {
          if (task.directory !== directory) continue
          if (running(task, now)) continue
          const forced = task.state.queued === true
          const scheduled =
            task.schedule.type !== "condition" && (task.state.nextRunAt ?? Number.POSITIVE_INFINITY) <= now
          if (!forced && (!task.enabled || !scheduled)) continue
          task.state.running = true
          task.state.runningSince = now
          task.state.queued = false
          if (task.schedule.type === "interval" || task.schedule.type === "daily" || task.schedule.type === "cron") {
            task.state.nextRunAt = Schedule.nextRunAt(task.schedule, now)
          }
          claimed.push(structuredClone(task))
        }
        return claimed
      })
    })

    const claimRun = Effect.fn("Scheduler.claimRun")(function* (input: { id: string; now: number }) {
      const directory = yield* InstanceState.directory
      return yield* mutate((store) => {
        const task = store.tasks.find((candidate) => candidate.id === input.id && candidate.directory === directory)
        if (!task || !task.enabled || running(task, input.now)) return undefined
        task.state.running = true
        task.state.runningSince = input.now
        task.state.queued = false
        return structuredClone(task)
      })
    })

    const claimChecks = Effect.fn("Scheduler.claimChecks")(function* (now: number) {
      const directory = yield* InstanceState.directory
      if (!(yield* schedulerEnabled())) return [] as Info[]
      return yield* mutate((store) => {
        const claimed: Info[] = []
        for (const task of store.tasks) {
          if (task.directory !== directory) continue
          if (task.schedule.type !== "condition") continue
          if (!task.enabled || running(task, now)) continue
          if (task.state.nextCheckAt === undefined || task.state.nextCheckAt > now) continue
          task.state.nextCheckAt = now + Schedule.conditionInterval(task.schedule)
          claimed.push(structuredClone(task))
        }
        return claimed
      })
    })

    const recordRun = Effect.fn("Scheduler.recordRun")(function* (input: {
      id: string
      sessionID?: string
      error?: string
      time: number
    }) {
      const directory = yield* InstanceState.directory
      yield* mutate((store) => {
        const task = store.tasks.find((candidate) => candidate.id === input.id && candidate.directory === directory)
        if (!task) return
        task.state.running = false
        delete task.state.runningSince
        task.state.queued = false
        task.state.lastRunAt = input.time
        task.state.runs += 1
        task.state.lastResult = input.error ? summarize(input.error) : "ok"
        if (input.sessionID) task.state.lastSessionID = input.sessionID
        if (task.schedule.type === "immediate" || task.schedule.type === "at") task.enabled = false
      })
    })

    const recordCheck = Effect.fn("Scheduler.recordCheck")(function* (input: {
      id: string
      matched: boolean
      time: number
    }) {
      const directory = yield* InstanceState.directory
      yield* mutate((store) => {
        const task = store.tasks.find((candidate) => candidate.id === input.id && candidate.directory === directory)
        if (!task) return
        task.state.lastCheckAt = input.time
        task.state.lastCheckMatched = input.matched
      })
    })

    return Service.of({
      list,
      get,
      add,
      remove,
      setEnabled,
      setSchedulerEnabled,
      schedulerEnabled,
      queue,
      claimDue,
      claimRun,
      claimChecks,
      recordRun,
      recordCheck,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Storage.node] })

export * as Scheduler from "./scheduler"
