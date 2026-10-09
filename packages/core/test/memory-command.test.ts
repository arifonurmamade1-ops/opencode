import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MemoryCommand } from "@opencode-ai/core/memory/command"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([CommandV2.node, MemoryCommand.node])))

describe("MemoryCommand", () => {
  it.effect("registers the built-in /memory command", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service

      const info = yield* command.get("memory")
      expect(info?.name).toBe("memory")
      expect(info?.description).toBe("Show and manage the persistent project memory")
      expect(info?.template).toContain("project memory")
      expect(info?.template).toContain("$ARGUMENTS")
    }),
  )

  it.effect("keeps later user-provided overrides", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* command.transform((draft) => {
        draft.update("memory", (item) => {
          item.template = "User template"
        })
      })

      expect(yield* command.get("memory")).toMatchObject({ template: "User template" })
    }),
  )
})
