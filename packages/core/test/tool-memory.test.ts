import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { Memory } from "@opencode-ai/core/memory"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { MemoryTool } from "@opencode-ai/core/tool/memory"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_memory_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Memory.node, ToolRegistry.node, ToolRegistry.toolsNode, MemoryTool.node]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Location.node, locationLayer],
    ],
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  deny = false
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

const call = (input: MemoryTool.Input, id = "call-memory") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: MemoryTool.name, input },
})

describe("MemoryTool", () => {
  it.effect("registers, saves project-scoped memory by default, and returns typed output", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* Memory.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([MemoryTool.name])

      const settled = yield* settleTool(
        registry,
        call({ action: "save", kind: "rule", key: "naming", content: "snake_case columns" }),
      )
      expect(settled.result).toMatchObject({ type: "text" })

      const stored = yield* service.list({ projectID: Project.ID.global })
      expect(stored).toHaveLength(1)
      expect(stored.map((entry) => entry.scope)).toEqual(["project"])
      expect(stored.map((entry) => entry.key)).toEqual(["naming"])
      expect(settled.output?.structured).toEqual({ entries: stored })
      expect(assertions).toMatchObject([{ sessionID, action: "memory", resources: ["*"], save: ["*"] }])
    }),
  )

  it.effect("defaults the session scope subject to the current session", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* Memory.Service

      yield* settleTool(
        registry,
        call({ action: "save", kind: "decision", key: "provider", content: "prefer local models", scope: "session" }),
      )

      const stored = yield* service.list({ projectID: Project.ID.global, scope: "session" })
      expect(stored.map((entry) => entry.subject)).toEqual([sessionID])
    }),
  )

  it.effect("lists memories and removes them by id, reporting misses", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* Memory.Service
      const saved = yield* service.save({
        projectID: Project.ID.global,
        scope: "project",
        kind: "bug",
        key: "flaky",
        content: "windows shell restarts",
      })

      const listed = yield* settleTool(registry, call({ action: "list" }))
      expect(listed.output?.structured).toEqual({ entries: [saved] })

      const removed = yield* settleTool(registry, call({ action: "remove", id: saved.id }))
      expect(removed.result).toEqual({ type: "text", value: JSON.stringify({ entries: [] }, null, 2) })
      expect(yield* service.list({ projectID: Project.ID.global })).toEqual([])

      const miss = yield* executeTool(registry, call({ action: "remove", id: saved.id }))
      expect(miss).toEqual({ type: "error", value: `No memory found with id ${saved.id}` })
    }),
  )

  it.effect("requires an explicit subject for task-scoped saves", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service

      const result = yield* executeTool(
        registry,
        call({ action: "save", kind: "result", key: "task-key", content: "done", scope: "task" }),
      )
      expect(result).toEqual({
        type: "error",
        value: "task-scoped memory requires an explicit subject task id",
      })
    }),
  )

  it.effect("does not persist memory when permission is denied", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* Memory.Service
      deny = true

      const result = yield* executeTool(
        registry,
        call({ action: "save", kind: "rule", key: "blocked", content: "nope" }),
      )
      expect(result).toEqual({ type: "error", value: "Unable to use memory" })
      expect(yield* service.list({ projectID: Project.ID.global })).toEqual([])
      expect(assertions).toMatchObject([{ sessionID, action: "memory", resources: ["*"], save: ["*"] }])
    }),
  )
})
