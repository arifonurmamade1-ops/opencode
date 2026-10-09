export * as ProjectMemory from "./memory-context"

import { Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { Memory } from "../memory"
import { makeLocationNode } from "../effect/app-node"
import { SystemContext } from "./index"
import { SystemContextRegistry } from "./registry"
import { compressToBudget, estimateTokens } from "./relevance"

const key = SystemContext.Key.make("project/memory")

const MAX_ENTRIES = 40
const TOKEN_BUDGET = 500

export interface MemoryDeps {
  readonly memory: Memory.Interface
  readonly projectID: Memory.Info["projectID"]
}

/** Formats one memory entry as a compact, model-readable line. */
export const formatEntry = (entry: Memory.Info): string =>
  `[${entry.scope}/${entry.kind}] ${entry.key}: ${entry.content}`

/**
 * Loads the persisted project memory for the given project. Best-effort: the
 * store itself never fails (defects die), so an empty list simply yields no
 * admission.
 */
export const loadMemory = (deps: MemoryDeps): Effect.Effect<string[]> =>
  deps.memory.list({ projectID: deps.projectID }).pipe(
    Effect.map((entries) => entries.slice(0, MAX_ENTRIES).map(formatEntry)),
  )

/**
 * Renders a budget-capped memory summary for the model.
 * Emits "" when there is nothing to admit so callers can fall back to
 * `SystemContext.empty`.
 */
export const render = (lines: ReadonlyArray<string>): string => {
  if (lines.length === 0) return ""
  const budgeted = compressToBudget(
    lines.map((text) => ({ text })),
    TOKEN_BUDGET,
    (text) => estimateTokens(text),
  )
  const head = "Project memory (persistent notes saved by you or previous sessions):"
  const body = budgeted.map((line) => `  - ${line.text}`).join("\n")
  const truncated =
    budgeted.length < lines.length
      ? `\n(${budgeted.length}/${lines.length} entries shown; remaining memory trimmed to stay within the token budget)`
      : ""
  return `${head}\n${body}${truncated}`
}

const source = (lines: ReadonlyArray<string>) =>
  SystemContext.make({
    key,
    codec: Schema.toCodecJson(Schema.Array(Schema.String)),
    load: Effect.succeed(lines),
    baseline: render,
    update: (_previous, current) =>
      `Project memory has changed. This list supersedes the previous memory.\n\n${render(current)}`,
    removed: () => "Project memory is no longer available.",
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const memory = yield* Memory.Service
    const registry = yield* SystemContextRegistry.Service

    yield* registry.register({
      key,
      load: loadMemory({ memory, projectID: location.project.id }).pipe(
        Effect.map((lines) => (lines.length === 0 ? SystemContext.empty : source(lines))),
        Effect.catch(() => Effect.succeed(SystemContext.empty)),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "project-memory",
  layer,
  deps: [Location.node, Memory.node, SystemContextRegistry.node],
})
