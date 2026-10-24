import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { Context, Effect, Layer, Option } from "effect"
import path from "path"

export type Info = {
  id: string
  path: string
  size: number
  updatedAt: number
}

export type VerifyResult = {
  ok: boolean
  problems: string[]
}

export interface Interface {
  readonly dir: () => Effect.Effect<string>
  readonly list: () => Effect.Effect<Info[]>
  readonly read: (id: string) => Effect.Effect<string | undefined>
  readonly write: (id: string, content: string) => Effect.Effect<string, FSUtil.Error>
  readonly verify: (input: { id: string; acceptance: readonly string[] }) => Effect.Effect<VerifyResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Artifact") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const state = yield* InstanceState.make<string>(() =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        return path.join(ctx.directory, ".opencode", "artifacts")
      }),
    )

    const dir = Effect.fn("Artifact.dir")(function* () {
      return yield* InstanceState.get(state)
    })

    const list = Effect.fn("Artifact.list")(function* () {
      const root = yield* InstanceState.get(state)
      const entries = yield* fs.readDirectoryEntries(root).pipe(Effect.catch(() => Effect.succeed([] as FSUtil.DirEntry[])))
      const infos: Info[] = []
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
        const file = path.join(root, entry.name)
        const stat = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat) continue
        infos.push({
          id: entry.name.slice(0, -".md".length),
          path: file,
          size: Number(stat.size),
          updatedAt: Option.getOrElse(stat.mtime, () => new Date(0)).getTime(),
        })
      }
      return infos.sort((a, b) => b.updatedAt - a.updatedAt)
    })

    const read = Effect.fn("Artifact.read")(function* (id: string) {
      const root = yield* InstanceState.get(state)
      const file = path.join(root, `${id}.md`)
      return yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
    })

    const write = Effect.fn("Artifact.write")(function* (id: string, content: string) {
      const root = yield* InstanceState.get(state)
      const file = path.join(root, `${id}.md`)
      yield* fs.writeWithDirs(file, content)
      return file
    })

    const verify = Effect.fn("Artifact.verify")(function* (input: { id: string; acceptance: readonly string[] }) {
      const root = yield* InstanceState.get(state)
      const file = path.join(root, `${input.id}.md`)
      const content = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const problems: string[] = []
      if (content === undefined) {
        problems.push(`artifact file not found: ${file}`)
        return { ok: false, problems }
      }
      if (!content.trim()) problems.push("artifact is empty")
      const lower = content.toLowerCase()
      for (const criterion of input.acceptance) {
        if (!lower.includes(criterion.toLowerCase())) problems.push(`acceptance not evidenced: ${criterion}`)
      }
      return { ok: problems.length === 0, problems }
    })

    return Service.of({ dir, list, read, write, verify })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })

export * as Artifact from "./artifact"
