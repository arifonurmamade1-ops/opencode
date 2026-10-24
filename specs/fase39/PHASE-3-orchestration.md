# FASE 39 — PHASE 3: Multi-agent orchestration

Date: 2026-10-24 (post PHASE 5, commit `895240d`).
Scope: a first-class orchestration layer on top of the Agent Manager (PHASE 2) with task dependencies, fan-out/fan-in, propagation of failures to dependents, parallel wave execution, and cancellation intent.

## What was implemented

- New service: `packages/opencode/src/orchestration.ts` (`Orchestration.Service`, `@opencode/Orchestration`).
  - `start(plan)` — validates the plan (unique ids, known deps, no self-dep, no cycles via Kahn), then runs steps in waves: ready steps (all deps completed) run in parallel via `AgentManager.start` with `concurrency: "unbounded"`; steps whose dependency failed/cancelled/skipped are marked `skipped`; terminal when all steps are done. Returns a `RunInfo` with per-step `StepResult` (status, session id, output, error).
  - `get(id)` / `list()` — process-local run registry scoped per instance directory.
  - `cancel(id)` — flips a running run to `cancelled` between waves (already-completed waves stay); observed by the running loop via the persisted run status.
  - Validation errors surface as `InvalidPlanError` (tagged): duplicate id, unknown dep, self-dep, cycle.
- Layer: `Orchestration.node` depends on `AgentManager.node`.

## Tests

- `packages/opencode/test/orchestration.test.ts` — 8/8 pass (43s):
  - dependency order (linear chain)
  - fan-out (independent steps)
  - fan-in (multi-dependency step waits)
  - skip propagation on dependency failure (run status `failed`, dependent `skipped`, independent step completes)
  - invalid plans (cycle, unknown dep, duplicate id, self-dep)
  - unknown run → `get`/`cancel` undefined
  - cancel after completion is a no-op status-wise
  - multi-run listing

## Limitations (FASE 40)

- Steps are awaited inline within each wave; a wave cannot be interrupted mid-flight (same limitation as Agent Manager). Cancellation takes effect between waves.
- Fan-in is implicit via `dependsOn`; there is no explicit aggregation primitive — callers combine `StepResult.output` from completed steps.
- No persistence: runs are process-local per instance directory.
- No retry/backoff per step beyond what `AgentManager.start` provides.

## Validation

- `bun test test/orchestration.test.ts` → 8/8 pass.
- `bun typecheck` (packages/opencode) → only the known untracked slide WIP errors.

## Next action

PHASE 11/12 (Performance + Benchmark + hardening) — or PHASE 10 (UI/UX + desktop) if desktop work is desired. Awaiting explicit go.
