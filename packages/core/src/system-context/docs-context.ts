export * as ProjectDocs from "./docs-context"

import { ChildProcess } from "effect/unstable/process"
import { Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { AppProcess } from "../process"
import { makeLocationNode } from "../effect/app-node"
import { SystemContext } from "./index"
import { SystemContextRegistry } from "./registry"
import { compressToBudget, estimateTokens } from "./relevance"

const key = SystemContext.Key.make("project/docs")

const MAX_DOCS = 25
const TOKEN_BUDGET = 500

/** Doc files get a structural salience weight — entry docs rank first. */
const docWeight = (path: string): number => {
  const base = path.split("/").pop() ?? ""
  if (base === "README.md" || base === "README.markdown") return 2
  if (/^docs\//.test(path) && path.split("/").length <= 3) return 1
  return 0
}

export interface DocsDeps {
  readonly proc: AppProcess.Interface
  readonly directory: Location.Interface["directory"]
}

/** Parse `git ls-files` output into trimmed, non-empty paths. */
export const parseDocs = (output: string): string[] =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

/** Keeps markdown docs and drops metadata (node_modules, etc.). */
export const filterDocs = (paths: ReadonlyArray<string>): string[] =>
  paths.filter(
    (path) => /\.md$|\.markdown$/.test(path) && !path.startsWith("node_modules/") && !path.startsWith(".git/"),
  )

/** Orders docs by structural salience (README/docs first, stable on ties). */
export const rankDocs = (docs: ReadonlyArray<string>): string[] =>
  Array.from(docs).sort((a, b) => docWeight(b) - docWeight(a) || a.localeCompare(b))

/**
 * Best-effort project docs for `cwd`, via `git ls-files`.
 *
 * Git is a best-effort observation: when the directory is not a git repo, git is
 * unavailable, or ls-files exits non-zero, nothing is admitted (`[]`) — never
 * `unavailable`, so it cannot block `SessionContextEpoch.initialize` outside a
 * git tree.
 */
export const loadDocs = (deps: DocsDeps): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const result = yield* deps.proc
      .run(ChildProcess.make("git", ["ls-files"], { cwd: deps.directory }))
      .pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (result === undefined || result.exitCode !== 0) return []
    return rankDocs(filterDocs(parseDocs(result.stdout.toString()))).slice(0, MAX_DOCS)
  })

/**
 * Renders a relevance-trimmed, budget-capped docs summary for the model.
 * Emits "" when there is nothing to admit so callers can fall back to
 * `SystemContext.empty`.
 */
export const render = (docs: ReadonlyArray<string>): string => {
  if (docs.length === 0) return ""
  const budgeted = compressToBudget(
    docs.map((doc) => ({ text: doc })),
    TOKEN_BUDGET,
    (text) => estimateTokens(text),
  )
  const head = "Project docs (README and documentation files):"
  const body = budgeted.map((doc) => `  ${doc.text}`).join("\n")
  const truncated =
    budgeted.length < docs.length
      ? `\n(${budgeted.length}/${docs.length} docs shown; remaining docs trimmed to stay within the token budget)`
      : ""
  return `${head}\n${body}${truncated}`
}

const source = (docs: ReadonlyArray<string>) =>
  SystemContext.make({
    key,
    codec: Schema.toCodecJson(Schema.Array(Schema.String)),
    load: Effect.succeed(docs),
    baseline: render,
    update: (_previous, current) =>
      `Project documentation has changed. This list supersedes the previous docs.\n\n${render(current)}`,
    removed: () => "Project documentation is no longer available.",
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const proc = yield* AppProcess.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service

    yield* registry.register({
      key,
      load: loadDocs({ proc, directory: location.directory }).pipe(
        Effect.map((docs) => (docs.length === 0 ? SystemContext.empty : source(docs))),
        Effect.catch(() => Effect.succeed(SystemContext.empty)),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "project-docs",
  layer,
  deps: [Location.node, AppProcess.node, SystemContextRegistry.node],
})
