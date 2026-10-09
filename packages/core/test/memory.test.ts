import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Memory } from "@opencode-ai/core/memory"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Memory.node])))

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

const project = Project.ID.global

describe("Memory", () => {
  it.effect("saves and lists project memory", () =>
    Effect.gen(function* () {
      yield* setup
      const memory = yield* Memory.Service

      const saved = yield* memory.save({
        projectID: project,
        scope: "project",
        kind: "rule",
        key: "naming",
        content: "Use snake_case for database columns",
      })

      expect(saved.id.startsWith("mem_")).toBe(true)
      expect(saved.projectID).toBe(project)

      const entries = yield* memory.list({ projectID: project })
      expect(entries.map((entry) => entry.key)).toEqual(["naming"])
      expect(entries.map((entry) => entry.kind)).toEqual(["rule"])
      expect(entries.map((entry) => entry.content)).toEqual(["Use snake_case for database columns"])
    }),
  )

  it.effect("updates the same key in place instead of duplicating", () =>
    Effect.gen(function* () {
      yield* setup
      const memory = yield* Memory.Service
      const input = {
        projectID: project,
        scope: "project" as const,
        kind: "convention" as const,
        key: "tests",
        content: "Run bun test from packages/core",
      }

      const first = yield* memory.save(input)
      const second = yield* memory.save({ ...input, kind: "command", content: "bun run typecheck" })

      expect(second.id).toBe(first.id)
      const entries = yield* memory.list({ projectID: project })
      expect(entries).toHaveLength(1)
      expect(entries.map((entry) => entry.content)).toEqual(["bun run typecheck"])
      expect(entries.map((entry) => entry.kind)).toEqual(["command"])
    }),
  )

  it.effect("isolates scopes and subjects", () =>
    Effect.gen(function* () {
      yield* setup
      const memory = yield* Memory.Service

      yield* memory.save({
        projectID: project,
        scope: "project",
        kind: "architecture",
        key: "storage",
        content: "SQLite via drizzle",
      })
      yield* memory.save({
        projectID: project,
        scope: "agent",
        kind: "result",
        key: "tests",
        content: "28/28 passing",
        subject: "coder",
      })

      const projectEntries = yield* memory.list({ projectID: project, scope: "project" })
      expect(projectEntries.map((entry) => entry.key)).toEqual(["storage"])

      const agentEntries = yield* memory.list({ projectID: project, scope: "agent", subject: "coder" })
      expect(agentEntries.map((entry) => entry.subject)).toEqual(["coder"])
      expect(agentEntries.map((entry) => entry.content)).toEqual(["28/28 passing"])

      const otherAgent = yield* memory.list({ projectID: project, scope: "agent", subject: "researcher" })
      expect(otherAgent).toEqual([])
    }),
  )

  it.effect("removes entries only for the owning project", () =>
    Effect.gen(function* () {
      yield* setup
      const memory = yield* Memory.Service

      const saved = yield* memory.save({
        projectID: project,
        scope: "session",
        kind: "decision",
        key: "provider",
        content: "Prefer local models",
        subject: "ses_test",
      })

      const foreign = yield* memory.remove({ projectID: Project.ID.make("prj_isolated"), id: saved.id })
      expect(foreign).toBe(false)
      expect(yield* memory.list({ projectID: project })).toHaveLength(1)

      expect(yield* memory.remove({ projectID: project, id: saved.id })).toBe(true)
      expect(yield* memory.remove({ projectID: project, id: saved.id })).toBe(false)
      expect(yield* memory.list({ projectID: project })).toEqual([])
    }),
  )

  it.effect("keeps other projects isolated", () =>
    Effect.gen(function* () {
      yield* setup
      const memory = yield* Memory.Service

      yield* memory.save({
        projectID: project,
        scope: "project",
        kind: "bug",
        key: "flaky",
        content: "Windows shell restarts drop foreground commands",
      })

      expect(yield* memory.list({ projectID: Project.ID.make("prj_other") })).toEqual([])
    }),
  )
})
