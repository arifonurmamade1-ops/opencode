export * as MemoryTool from "./memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Memory } from "../memory"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "memory"

export const Input = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("save"),
    kind: Memory.Kind.annotate({
      description:
        "Category of knowledge: architecture, decision, rule, convention, bug, command, config, user_decision or result",
    }),
    key: Schema.String.annotate({
      description: "Stable short label; saving the same key again updates that memory in place",
    }),
    content: Schema.String.annotate({ description: "The knowledge to remember, in one concise line" }),
    scope: Memory.Scope.pipe(Schema.optional).annotate({
      description: "project (default), agent, task or session",
    }),
    subject: Schema.String.pipe(Schema.optional).annotate({
      description:
        "Scope anchor. Defaults to the current agent or session for those scopes; task scope requires an explicit task id",
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("list"),
    scope: Memory.Scope.pipe(Schema.optional).annotate({ description: "Optional scope filter" }),
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    id: Memory.ID.annotate({ description: "Memory id from a previous save or list" }),
  }),
])
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  entries: Schema.Array(Memory.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: typeof Output.Encoded) => JSON.stringify(output, null, 2)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const memory = yield* Memory.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Persist and recall durable project memory (architecture, decisions, rules, conventions, known bugs, commands, configuration, user decisions, results). Save under a stable key to update in place, list to recall, remove by id. Project-scoped memories are injected into project context and survive across sessions.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const projectID = location.project.id

              if (input.action === "list") {
                return { entries: yield* memory.list({ projectID, scope: input.scope }) }
              }

              if (input.action === "remove") {
                const removed = yield* memory.remove({ projectID, id: input.id })
                if (!removed)
                  return yield* Effect.fail(new ToolFailure({ message: `No memory found with id ${input.id}` }))
                return { entries: [] }
              }

              const scope = input.scope ?? "project"
              const subject =
                input.subject ?? (scope === "session" ? context.sessionID : scope === "agent" ? context.agent : "")
              if (scope === "task" && !subject)
                return yield* Effect.fail(
                  new ToolFailure({ message: "task-scoped memory requires an explicit subject task id" }),
                )
              const entry = yield* memory.save({
                projectID,
                scope,
                kind: input.kind,
                key: input.key,
                content: input.content,
                subject,
              })
              return { entries: [entry] }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to use memory" }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memory",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Memory.node, Location.node],
})
