import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { Memory } from "@opencode-ai/core/memory"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ProjectMemory } from "@opencode-ai/core/system-context/memory-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("project") })),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Memory.node, SystemContextRegistry.node, ProjectMemory.node]),
    [[Location.node, locationLayer]],
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

const entry = (input: { key: string; content: string; kind?: Memory.Kind }): Memory.Info => ({
  id: Memory.ID.make(`mem_${input.key}`),
  projectID: Project.ID.global,
  scope: "project",
  kind: input.kind ?? "rule",
  subject: "",
  key: input.key,
  content: input.content,
})

const stub = (entries: Memory.Info[]): Memory.Interface => ({
  list: () => Effect.succeed(entries),
  save: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
})

describe("ProjectMemory", () => {
  test("formatEntry renders a compact scope/kind line", () => {
    expect(ProjectMemory.formatEntry(entry({ key: "naming", content: "snake_case columns" }))).toBe(
      "[project/rule] naming: snake_case columns",
    )
  })

  test("render emits nothing for empty memory and a budgeted summary otherwise", () => {
    expect(ProjectMemory.render([])).toBe("")
    const rendered = ProjectMemory.render(["[project/rule] naming: snake_case columns"])
    expect(rendered).toContain("Project memory")
    expect(rendered).toContain("[project/rule] naming: snake_case columns")
  })

  test("render annotates truncation when the token budget trims the list", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `[project/decision] d${i}: decision number ${i}`)
    expect(ProjectMemory.render(lines)).toContain("shown")
  })

  it.effect("loadMemory formats entries and caps the list", () =>
    Effect.gen(function* () {
      const entries = Array.from({ length: 45 }, (_, i) => entry({ key: `k${i}`, content: `c${i}` }))
      const lines = yield* ProjectMemory.loadMemory({ memory: stub(entries), projectID: Project.ID.global })
      expect(lines).toHaveLength(40)
      expect(lines[0]).toBe("[project/rule] k0: c0")
    }),
  )

  it.effect("admits persisted memory into the system context baseline", () =>
    Effect.gen(function* () {
      yield* setup
      const memory = yield* Memory.Service
      yield* memory.save({
        projectID: Project.ID.global,
        scope: "project",
        kind: "rule",
        key: "naming",
        content: "snake_case for database columns",
      })

      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())

      expect(initialized.baseline).toContain("Project memory")
      expect(initialized.baseline).toContain("[project/rule] naming: snake_case for database columns")
    }),
  )

  it.effect("emits nothing when the project has no memory", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* SystemContextRegistry.Service
      expect(yield* SystemContext.initialize(yield* registry.load())).toEqual({ baseline: "", snapshot: {} })
    }),
  )
})
