export * as MemoryCommand from "./command"

import { Effect, Layer } from "effect"
import { CommandV2 } from "../command"
import { makeLocationNode } from "../effect/app-node"

const template = `Show the current project memory from your context, grouped by scope and kind with each entry's key and content. Then follow the instruction below using the memory tool (save updates in place by key, remove by id); with no instruction, just present the memory.

$ARGUMENTS`

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const command = yield* CommandV2.Service
    yield* command.transform((draft) => {
      // Only seed the built-in when the user has not defined /memory, so
      // config-registered transforms always win regardless of registration order.
      if (draft.get("memory") !== undefined) return
      draft.update("memory", (item) => {
        item.description = "Show and manage the persistent project memory"
        item.template = template
      })
    })
  }),
)

export const node = makeLocationNode({ name: "memory-command", layer, deps: [CommandV2.node] })
