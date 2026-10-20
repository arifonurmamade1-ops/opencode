import path from "path"
import { Effect, Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import * as Tool from "./tool"
import { AutonomousTask } from "@/autonomous/task"
import DESCRIPTION from "./autonomous.txt"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "update", "block", "deliver", "status"]).annotate({
    description: "Operation to perform",
  }),
  objective: Schema.optional(Schema.String).annotate({
    description: "The user requirement in one or two sentences (action=start)",
  }),
  acceptance: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Concrete acceptance criteria (action=start, at least one)",
  }),
  stage: Schema.optional(Schema.Literals([...AutonomousTask.Stages])).annotate({
    description: "Stage to update or block",
  }),
  stageStatus: Schema.optional(AutonomousTask.UpdateStatus).annotate({
    description: "New stage status: in_progress, done, or skipped (action=update)",
  }),
  evidence: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Concrete evidence: command and result, file path, URL, or finding",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Why the stage was skipped (required for skipped)",
  }),
  what: Schema.optional(Schema.String).annotate({ description: "What is blocked (action=block)" }),
  why: Schema.optional(Schema.String).annotate({ description: "Why it is blocked (action=block)" }),
  needs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "What is needed to unblock (action=block)",
  }),
})

type Metadata = {
  task?: AutonomousTask.Info
  artifactPath?: string
  problems?: string[]
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeTask = Schema.decodeUnknownOption(AutonomousTask.Info)

export const AutonomousTaskTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service>(
  "autonomous_task",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const load = (file: string) =>
      Effect.gen(function* () {
        const text = yield* fs.readFileStringSafe(file)
        if (text === undefined) return { ok: true as const, task: undefined }
        const value = decodeJson(text)
        if (Option.isNone(value)) {
          return { ok: false as const, error: `Autonomous task state is not valid JSON: ${file}` }
        }
        const task = decodeTask(value.value)
        if (Option.isNone(task)) {
          return { ok: false as const, error: `Autonomous task state has an invalid shape: ${file}` }
        }
        return { ok: true as const, task: task.value }
      })

    const save = (file: string, task: AutonomousTask.Info) => fs.writeWithDirs(file, JSON.stringify(task, null, 2))

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const stateFile = path.join(Global.Path.data, "autonomous", `${encodeURIComponent(ctx.sessionID)}.json`)
          const loaded = yield* load(stateFile)
          if (!loaded.ok) return failure(loaded.error)
          const task = loaded.task
          const artifactPath = (id: string) => path.join(instance.directory, ".opencode", "autonomous", `${id}.md`)

          switch (params.action) {
            case "start": {
              if (!params.objective?.trim()) return failure('action "start" requires "objective".')
              const acceptance = (params.acceptance ?? []).map((item) => item.trim()).filter(Boolean)
              if (acceptance.length === 0) {
                return failure('action "start" requires at least one acceptance criterion in "acceptance".')
              }
              if (task && task.status !== "delivered") {
                return success(
                  task,
                  "An autonomous task is already active in this session. Continue it instead of starting another.",
                )
              }
              const now = Date.now()
              const created = AutonomousTask.create({
                id: Identifier.create("atk", "ascending"),
                sessionID: ctx.sessionID,
                objective: params.objective,
                acceptance,
                now,
              })
              yield* save(stateFile, created)
              return success(created, "Autonomous task started. Begin with the understand stage.")
            }

            case "update": {
              if (!task) return failure('No autonomous task exists in this session. Call action "start" first.')
              if (!params.stage) return failure('action "update" requires "stage".')
              if (!params.stageStatus) return failure('action "update" requires "stageStatus".')
              const result = AutonomousTask.update(task, {
                stage: params.stage,
                status: params.stageStatus,
                evidence: params.evidence,
                reason: params.reason,
                now: Date.now(),
              })
              if (!result.ok) return failure(result.error)
              yield* save(stateFile, result.task)
              return success(result.task, `Stage "${params.stage}" marked ${params.stageStatus}.`)
            }

            case "block": {
              if (!task) return failure('No autonomous task exists in this session. Call action "start" first.')
              if (!params.stage) return failure('action "block" requires "stage".')
              if (!params.what?.trim()) return failure('action "block" requires "what".')
              if (!params.why?.trim()) return failure('action "block" requires "why".')
              const result = AutonomousTask.block(task, {
                stage: params.stage,
                what: params.what,
                why: params.why,
                needs: params.needs,
                evidence: params.evidence,
                now: Date.now(),
              })
              if (!result.ok) return failure(result.error)
              const file = artifactPath(result.task.id)
              const blocked: AutonomousTask.Info = { ...result.task, artifactPath: file }
              yield* fs.writeWithDirs(file, AutonomousTask.render(blocked))
              yield* save(stateFile, blocked)
              return {
                title: "Autonomous task blocked",
                output: [
                  "BLOCKED",
                  `WHAT: ${blocked.blocker?.what}`,
                  `WHY: ${blocked.blocker?.why}`,
                  "NEEDED:",
                  ...(blocked.blocker?.needs.length
                    ? blocked.blocker.needs.map((item) => `- ${item}`)
                    : ["- Resolve the blocker described above."]),
                  "",
                  `Artifact: ${displayPath(instance.directory, file)}`,
                  "The task is not delivered. Resolve the blocker, then update the stage and continue.",
                ].join("\n"),
                metadata: { task: blocked, artifactPath: file },
              }
            }

            case "deliver": {
              if (!task) return failure('No autonomous task exists in this session. Call action "start" first.')
              if (task.status === "delivered") {
                const file = task.artifactPath ?? artifactPath(task.id)
                return success(task, `Already delivered. Artifact: ${displayPath(instance.directory, file)}`)
              }
              const problems = AutonomousTask.deliveryProblems(task)
              if (problems.length > 0) {
                return {
                  title: "Autonomous task not ready",
                  output: [
                    "DELIVERY BLOCKED: the task does not meet the evidence gates.",
                    ...problems.map((problem) => `- ${problem}`),
                    "",
                    AutonomousTask.render(task),
                  ].join("\n"),
                  metadata: { task, problems },
                }
              }
              const file = artifactPath(task.id)
              const delivered = AutonomousTask.markDelivered(task, file, Date.now())
              yield* fs.writeWithDirs(file, AutonomousTask.render(delivered))
              yield* save(stateFile, delivered)
              return {
                title: "Autonomous task delivered",
                output: [
                  "DELIVERED",
                  `Artifact: ${displayPath(instance.directory, file)}`,
                  "",
                  AutonomousTask.render(delivered),
                ].join("\n"),
                metadata: { task: delivered, artifactPath: file },
              }
            }

            case "status": {
              if (!task) {
                return failure(
                  'No autonomous task exists in this session. Call action "start" with an objective and acceptance criteria.',
                )
              }
              return success(task, "Current autonomous task state.")
            }
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

function success(task: AutonomousTask.Info, message: string) {
  return {
    title: `Autonomous task - ${task.status}`,
    output: `${message}\n\n${AutonomousTask.render(task)}`,
    metadata: { task, ...(task.artifactPath ? { artifactPath: task.artifactPath } : {}) },
  }
}

function failure(output: string) {
  return {
    title: "Autonomous task",
    output,
    metadata: {} as Metadata,
  }
}

function displayPath(root: string, file: string) {
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return file
  return relative.replaceAll(path.sep, "/")
}
