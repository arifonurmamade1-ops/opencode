import path from "path"
import { describe, expect } from "bun:test"
import { Artifact } from "@/artifact"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { TestInstance } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

const layer = LayerNode.compile(Artifact.node)
const it = testEffect(layer)

describe("artifact", () => {
  it.instance(
    "writes and reads an artifact",
    () =>
      Effect.gen(function* () {
        const artifact = yield* Artifact.Service
        const file = yield* artifact.write("report", "# Report\n\nhello")
        expect(file.endsWith(path.join(".opencode", "artifacts", "report.md"))).toBe(true)

        const content = yield* artifact.read("report")
        expect(content).toBe("# Report\n\nhello")

        const dir = yield* artifact.dir()
        expect(dir.endsWith(path.join(".opencode", "artifacts"))).toBe(true)
      }),
    30_000,
  )

  it.instance("lists written artifacts with metadata", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.Service
      yield* artifact.write("a", "alpha")
      yield* artifact.write("b", "beta body")

      const list = yield* artifact.list()
      expect(list.map((item) => item.id).sort()).toEqual(["a", "b"])
      const beta = list.find((item) => item.id === "b")!
      expect(beta.size).toBe("beta body".length)
      expect(beta.updatedAt).toBeGreaterThan(0)
    }),
  )

  it.instance("returns undefined for a missing artifact", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.Service
      expect(yield* artifact.read("nope")).toBeUndefined()
    }),
  )

  it.instance("verifies acceptance criteria against artifact content", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.Service
      yield* artifact.write("report", "# Report\n\n- item one done\n- item two done")

      const ok = yield* artifact.verify({ id: "report", acceptance: ["item one", "ITEM TWO"] })
      expect(ok.ok).toBe(true)
      expect(ok.problems).toEqual([])

      const bad = yield* artifact.verify({ id: "report", acceptance: ["item one", "missing criterion"] })
      expect(bad.ok).toBe(false)
      expect(bad.problems).toContain("acceptance not evidenced: missing criterion")

      const missing = yield* artifact.verify({ id: "nope", acceptance: ["x"] })
      expect(missing.ok).toBe(false)
      expect(missing.problems[0]).toContain("artifact file not found")
    }),
  )

  it.instance("flags empty artifacts", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.Service
      yield* artifact.write("empty", "   ")
      const result = yield* artifact.verify({ id: "empty", acceptance: [] })
      expect(result.ok).toBe(false)
      expect(result.problems).toContain("artifact is empty")
    }),
  )

  it.instance("rejects artifact ids that escape the artifact directory", () =>
    Effect.gen(function* () {
      const artifact = yield* Artifact.Service
      const test = yield* TestInstance
      const ids = ["../escaped", "../../escaped", "..\\escaped", "nested/report", "..", "report:stream"]

      for (const id of ids) {
        const outcome = yield* artifact.write(id, "nope").pipe(Effect.exit)
        expect(Exit.isFailure(outcome)).toBe(true)
      }

      expect(yield* artifact.read("../../escaped")).toBeUndefined()
      const verify = yield* artifact.verify({ id: "../../escaped", acceptance: [] })
      expect(verify.ok).toBe(false)
      expect(verify.problems[0]).toContain("invalid artifact id")

      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, ".opencode", "escaped.md")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "escaped.md")).exists())).toBe(false)
    }),
  )
})
