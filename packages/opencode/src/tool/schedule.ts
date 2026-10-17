import { Effect, Schema } from "effect"
import { Provider } from "@/provider/provider"
import { Scheduler } from "../scheduler/scheduler"
import { Schedule } from "../scheduler/schedule"
import * as Tool from "./tool"
import DESCRIPTION from "./schedule.txt"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["add", "list", "remove", "enable", "disable", "run", "status"]).annotate({
    description: "Operation to perform",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Task id (required for remove, enable, disable and run)",
  }),
  name: Schema.optional(Schema.String).annotate({ description: "Short human name for the task (action=add)" }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "What the agent should do when the task runs (action=add)",
  }),
  schedule: Schema.optional(Scheduler.ScheduleSpec).annotate({
    description: "When or if the task runs (action=add)",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "For action=add: start enabled (default true). For action=status: turn the whole scheduler on or off",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Agent to run the task with (defaults to the session default)",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model as provider/model (defaults to the session default)",
  }),
})

type Metadata = {
  task?: Scheduler.Info
  tasks?: Scheduler.Info[]
}

export const ScheduleTool = Tool.define<typeof Parameters, Metadata, Scheduler.Service>(
  "schedule",
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          switch (params.action) {
            case "add": {
              if (!params.prompt) return failure('action "add" requires "prompt".')
              if (!params.schedule) return failure('action "add" requires "schedule".')
              if (params.model && !isModel(params.model))
                return failure(`Invalid model "${params.model}". Use "provider/model".`)
              const result = yield* scheduler
                .add({
                  name: params.name,
                  prompt: params.prompt,
                  schedule: params.schedule,
                  enabled: params.enabled,
                  agent: params.agent,
                  model: params.model ? Provider.parseModel(params.model) : undefined,
                })
                .pipe(
                  Effect.catchIf(Scheduler.InvalidSchedule.isInstance, (error) => Effect.succeed(error.message)),
                )
              if (typeof result === "string") return failure(result)
              return {
                title: "Scheduled task",
                output: `${formatTask(result)}\n\nThe scheduler will run it while this project is open.`,
                metadata: { task: result },
              }
            }
            case "list": {
              const tasks = yield* scheduler.list()
              return {
                title: `${tasks.length} scheduled task(s)`,
                output:
                  tasks.length === 0 ? "No scheduled tasks in this project." : tasks.map(formatTask).join("\n\n"),
                metadata: { tasks },
              }
            }
            case "run": {
              if (!params.id) return failure('action "run" requires "id".')
              const task = yield* scheduler.queue(params.id)
              if (!task) return failure(`No task found with id ${params.id}.`)
              return {
                title: "Scheduled task",
                output: `Task ${task.id} queued; it runs on the next scheduler tick.`,
                metadata: { task },
              }
            }
            case "remove": {
              if (!params.id) return failure('action "remove" requires "id".')
              const removed = yield* scheduler.remove(params.id)
              return {
                title: "Scheduled task",
                output: removed ? `Removed task ${params.id}.` : `No task found with id ${params.id}.`,
                metadata: {},
              }
            }
            case "enable":
            case "disable": {
              if (!params.id) return failure(`action "${params.action}" requires "id".`)
              const task = yield* scheduler.setEnabled({ id: params.id, enabled: params.action === "enable" })
              if (!task) return failure(`No task found with id ${params.id}.`)
              return { title: "Scheduled task", output: formatTask(task), metadata: { task } }
            }
            case "status": {
              if (params.enabled !== undefined) yield* scheduler.setSchedulerEnabled(params.enabled)
              const enabled = yield* scheduler.schedulerEnabled()
              const tasks = yield* scheduler.list()
              const next = tasks
                .filter((task) => task.enabled)
                .map((task) => (task.schedule.type === "condition" ? task.state.nextCheckAt : task.state.nextRunAt))
                .filter((value) => value !== undefined)
                .sort((a, b) => a - b)[0]
              return {
                title: "Scheduler status",
                output: [
                  `Scheduler is ${enabled ? "enabled" : "disabled"}.`,
                  `${tasks.length} task(s) in this project.`,
                  next !== undefined ? `Next run: ${new Date(next).toISOString()}.` : undefined,
                ]
                  .filter((line) => line !== undefined)
                  .join("\n"),
                metadata: { tasks },
              }
            }
          }
        }),
    }
  }),
)

function failure(output: string) {
  return { title: "schedule", output, metadata: {} as Metadata }
}

function isModel(value: string) {
  const [provider, ...rest] = value.split("/")
  return Boolean(provider) && rest.join("/").length > 0
}

function formatTask(task: Scheduler.Info) {
  const next = task.schedule.type === "condition" ? task.state.nextCheckAt : task.state.nextRunAt
  return [
    `${task.id}${task.name ? ` "${task.name}"` : ""} (${task.enabled ? "enabled" : "disabled"})`,
    `  prompt: ${task.prompt}`,
    `  schedule: ${Schedule.describeSpec(task.schedule)}`,
    next !== undefined ? `  next: ${new Date(next).toISOString()}` : undefined,
    task.state.lastRunAt !== undefined
      ? `  last run: ${new Date(task.state.lastRunAt).toISOString()} (${task.state.lastResult ?? "unknown"})`
      : undefined,
    task.state.lastSessionID ? `  session: ${task.state.lastSessionID}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}
