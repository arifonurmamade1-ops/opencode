import { Context, Effect, Layer, Option } from "effect"
import { Catalog } from "./catalog"
import { ModelCost } from "./model-cost"
import { ModelV2 } from "./model"
import { makeGlobalNode } from "./effect/app-node"
import { SessionRunnerModel } from "./session/runner/model"
import { ModelFallback } from "./session/runner/model-fallback"

export interface Policy {
  /** Prefer zero-cost models before priced ones. Defaults to true. */
  readonly freeFirst?: boolean
  /** Optional preferred model; used as primary when present in the available set. */
  readonly preferred?: ModelV2.Info
}

export interface RouteResult {
  readonly primary: ModelV2.Info | undefined
  readonly alternatives: ReadonlyArray<ModelV2.Info>
}

export interface Interface {
  /** Route over an explicitly provided model set. */
  readonly route: (input: {
    readonly available: ReadonlyArray<ModelV2.Info>
    readonly preferred?: ModelV2.Info
    readonly freeFirst?: boolean
  }) => Effect.Effect<RouteResult>
  /** Route over the current Location's Catalog. Degrades to an empty result when no Catalog is present. */
  readonly routeFromCatalog: (input?: { readonly preferred?: ModelV2.Info; readonly freeFirst?: boolean }) => Effect.Effect<RouteResult>
  /** Step to the next model after `previous` in a routed chain (undefined when exhausted). */
  readonly next: (chain: RouteResult, previous: ModelV2.Info | undefined) => ModelV2.Info | undefined
  /** Run `attempt` against the chain, stepping to alternatives only on errors accepted by `shouldFallback`. */
  readonly withFallback: <A, E>(
    chain: RouteResult,
    attempt: (preferred: ModelV2.Info | undefined) => Effect.Effect<A, E>,
    shouldFallback: (error: E) => boolean,
  ) => Effect.Effect<A, E>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ModelRouter") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Effect.serviceOption(Catalog.Service)

    const route = Effect.fn("ModelRouter.route")(function* (input: {
      readonly available: ReadonlyArray<ModelV2.Info>
      readonly preferred?: ModelV2.Info
      readonly freeFirst?: boolean
    }) {
      const freeFirst = input.freeFirst ?? true
      const ordered = ModelFallback.order(input.available, freeFirst)
      const primary = input.preferred
        ? ordered.find((m) => m.providerID === input.preferred!.providerID && m.id === input.preferred!.id) ?? ordered[0]
        : ordered[0]
      return { primary, alternatives: ordered.filter((m) => m !== primary) } satisfies RouteResult
    })

    const routeFromCatalog = Effect.fn("ModelRouter.routeFromCatalog")(function* (input?: {
      readonly preferred?: ModelV2.Info
      readonly freeFirst?: boolean
    }) {
      if (Option.isNone(catalog)) return { primary: undefined, alternatives: [] } satisfies RouteResult
      const available = yield* catalog.value.model.available()
      return yield* route({ available, preferred: input?.preferred, freeFirst: input?.freeFirst })
    })

    const next = (chain: RouteResult, previous: ModelV2.Info | undefined): ModelV2.Info | undefined =>
      ModelFallback.nextAlternative({ primary: chain.primary, alternatives: [...chain.alternatives] }, previous)

    const withFallback = <A, E>(
      chain: RouteResult,
      attempt: (preferred: ModelV2.Info | undefined) => Effect.Effect<A, E>,
      shouldFallback: (error: E) => boolean,
    ): Effect.Effect<A, E> =>
      ModelFallback.withFallback({ primary: chain.primary, alternatives: [...chain.alternatives] }, attempt, shouldFallback)

    return Service.of({ route, routeFromCatalog, next, withFallback })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

export * as ModelRouter from "./model-router"
