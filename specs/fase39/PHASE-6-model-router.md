# FASE 39 — PHASE 6: Model Router + fallback

Date: 2026-10-24 (post PHASE 2, commit `a51f4c5`).
Scope: provide a standalone Model Router service that selects an ordered model chain (primary + alternatives) from a catalog/available set under a policy, independent of a session turn, reusing the existing fallback ordering and `withFallback` machinery.

## What was implemented

- New service: `packages/core/src/model-router.ts` (`ModelRouter.Service`, `@opencode/v2/ModelRouter`).
  - `route({ available, preferred?, freeFirst? })` — orders supported models free-first (unless disabled) then release-descending, picks `preferred` as primary when present else the first ordered, alternatives = the rest.
  - `routeFromCatalog({ preferred?, freeFirst? })` — routes over the current Location's Catalog; degrades to an empty result when no Catalog is in context (matches `ModelFallback.chainFor`).
  - `next(chain, previous)` — steps to the next model after `previous` (undefined when exhausted or no previous).
  - `withFallback(chain, attempt, shouldFallback)` — delegates to `ModelFallback.withFallback`.
- Reuses `SessionRunnerModel.supported` (filter) and `ModelFallback.order`/`nextAlternative`/`withFallback` (ordering + stepping + retry). No duplicated ordering logic.
- Layer: global node with no required deps (Catalog is optional via `Effect.serviceOption`).

## Tests

- `packages/core/test/model-router.test.ts` — 8/8 pass (3.5s):
  - free-first + release-descending ordering
  - `freeFirst: false` (release-descending only)
  - preferred model as primary when present
  - fallback to first ordered when preferred absent
  - `routeFromCatalog` degrades to empty without a Catalog
  - `next` stepping + undefined at exhaustion
  - `withFallback` steps on accepted errors and surfaces the last error when exhausted
  - `withFallback` does not step on rejected errors

## Limitations (FASE 40)

- Capability/cost/latency-aware selection beyond free-first + release order is not implemented; `Policy` only exposes `freeFirst` and `preferred`. A richer router (capability requirements, cost ceilings, latency) is a follow-up.
- `routeFromCatalog` depends on a provided Catalog; without one it returns empty (consistent with `ModelFallback.chainFor`).
- The router does not persist or cache routes; callers route per decision.

## Validation

- `bun test test/model-router.test.ts` → 8/8 pass.
- `bun typecheck` (packages/core) → only the known untracked slide WIP errors.

## Next action

PHASE 5 (Artifacts + verification) — small, builds on the autonomous task module. Awaiting explicit go.
