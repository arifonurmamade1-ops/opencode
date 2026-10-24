import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelRouter } from "@opencode-ai/core/model-router"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const makeModel = (providerID: string, id: string, released: number, free: boolean) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(id as ModelV2.ID),
    providerID: ProviderV2.ID.make(providerID as ProviderV2.ID),
    name: id,
    api: { id: ModelV2.ID.make(id as ModelV2.ID), type: "aisdk", package: "@ai-sdk/openai" },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: { apiKey: "secret" } },
    variants: [],
    time: { released },
    cost: free
      ? [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
      : [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

const free = (id: string, released: number) => makeModel("alpha", id, released, true)
const paid = (id: string, released: number) => makeModel("beta", id, released, false)

const layer = LayerNode.compile(ModelRouter.node)
const it = testEffect(layer)

describe("model router", () => {
  it.effect("orders available models free-first then release-descending", () =>
    Effect.gen(function* () {
      const router = yield* ModelRouter.Service
      const result = yield* router.route({
        available: [paid("p-old", 1), free("f-old", 2), free("f-new", 5), paid("p-new", 10)],
      })
      expect(result.primary?.id).toBe("f-new")
      expect(result.alternatives.map((m) => m.id)).toEqual(["f-old", "p-new", "p-old"])
    }),
  )

  it.effect("honours freeFirst=false (release-descending only)", () =>
    Effect.gen(function* () {
      const router = yield* ModelRouter.Service
      const result = yield* router.route({
        available: [free("f-old", 2), paid("p-new", 10), free("f-new", 5)],
        freeFirst: false,
      })
      expect(result.primary?.id).toBe("p-new")
      expect(result.alternatives.map((m) => m.id)).toEqual(["f-new", "f-old"])
    }),
  )

  it.effect("uses a preferred model as primary when present", () =>
    Effect.gen(function* () {
      const router = yield* ModelRouter.Service
      const preferred = paid("p-new", 10)
      const result = yield* router.route({
        available: [free("f-new", 5), paid("p-new", 10)],
        preferred,
      })
      expect(result.primary?.id).toBe("p-new")
      expect(result.alternatives.map((m) => m.id)).toEqual(["f-new"])
    }),
  )

  it.effect("falls back to the first ordered model when preferred is absent", () =>
    Effect.gen(function* () {
      const router = yield* ModelRouter.Service
      const result = yield* router.route({
        available: [free("f-new", 5)],
        preferred: paid("missing", 99),
      })
      expect(result.primary?.id).toBe("f-new")
      expect(result.alternatives).toHaveLength(0)
    }),
  )

  it.effect("routeFromCatalog degrades to empty without a catalog", () =>
    Effect.gen(function* () {
      const router = yield* ModelRouter.Service
      const result = yield* router.routeFromCatalog()
      expect(result.primary).toBeUndefined()
      expect(result.alternatives).toHaveLength(0)
    }),
  )

  it.effect("next steps through the chain and returns undefined when exhausted", () =>
    Effect.gen(function* () {
      const router = yield* ModelRouter.Service
      const chain = yield* router.route({ available: [free("a", 3), free("b", 2), free("c", 1)] })
      // Stepping after the primary yields the first alternative.
      expect(router.next(chain, chain.primary)?.id).toBe("b")
      // Stepping after an alternative yields the following one.
      expect(router.next(chain, chain.alternatives[0]!)?.id).toBe("c")
      // An undefined `previous` has no successor in this helper (the primary is
      // reached via `chain.primary`, not via `next`); consistent with
      // ModelFallback.nextAlternative.
      expect(router.next(chain, undefined)).toBeUndefined()
      // The last model has no successor.
      expect(router.next(chain, chain.alternatives[1]!)).toBeUndefined()
    }),
  )

  it.effect("withFallback steps on accepted errors and surfaces the last error when exhausted", () =>
    Effect.gen(function* () {
      const router = yield* ModelRouter.Service
      const chain = yield* router.route({ available: [free("a", 3), free("b", 2)] })
      const seen: string[] = []
      const error = yield* router
        .withFallback(
          chain,
          (preferred) => {
            seen.push(preferred?.id ?? "none")
            return Effect.fail(new Error(`boom-${preferred?.id ?? "none"}`))
          },
          () => true,
        )
        .pipe(Effect.flip)
      expect(seen).toEqual(["a", "b"])
      expect(error.message).toBe("boom-b")
    }),
  )

  it.effect("withFallback does not step on rejected errors", () =>
    Effect.gen(function* () {
      const router = yield* ModelRouter.Service
      const chain = yield* router.route({ available: [free("a", 3), free("b", 2)] })
      const seen: string[] = []
      const error = yield* router
        .withFallback(
          chain,
          (preferred) => {
            seen.push(preferred?.id ?? "none")
            return Effect.fail(new Error("no-fallback"))
          },
          () => false,
        )
        .pipe(Effect.flip)
      expect(seen).toEqual(["a"])
      expect(error.message).toBe("no-fallback")
    }),
  )
})
