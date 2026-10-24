# FASE 39 — PHASES 11 & 12: Performance, Benchmark + hardening

Date: 2026-10-24 (post PHASE 3, commit `f1928fd`).

## PHASE 11 — Performance

Status: **Partial (documented, not fabricated)**.

The codebase already provides:
- Telemetry module: `packages/opencode/src/telemetry.ts`.
- A benchmark service (`packages/opencode/src/benchmark/*`) whose cases are deterministic and do not call models, so repeated runs are cheap and reproducible.
- Persistence of every benchmark run as JSON under the global data directory, plus objective comparison of two runs.

No dedicated performance module, profiling harness, or latency regression gate was added in this arc. Per FASE 40, adding a "performance" feature requires measured workloads and a baseline to compare against; defining those ad hoc would be faking. Candidate follow-ups (out of scope here, requiring measured baselines):
- A small, opt-in timing wrapper around the orchestrator/agent-manager run paths, reported via telemetry.
- A CI gate that fails when a benchmark case regresses beyond a threshold.

## PHASE 12 — Benchmark + hardening

Status: **Done (validated)**.

- Benchmark service exists (`packages/opencode/src/benchmark/{benchmark,cases,report}.ts`) with a static case catalog, in-process execution with a 60s per-case timeout, JSON persistence, listing, get, and comparison. Registered as a tool in `packages/opencode/src/tool/registry.ts` via `Benchmark.node`.
- `bun test test/benchmark/run.test.ts` → 3/3 pass (55s).
- Hardening delivered across this arc:
  - FASE 38: browser launcher error/grace coverage, scheduler failed-run + broken-check recovery, stale running-marker reclaim, report truncation, background-job `waitForPromotion` semantics, provider-retry coverage audited (already present).
  - FASE 39 sweep: fixed `EffectFlock` lock-root recreation after state-dir wipe (real production bug), resolved slow-host budgets (browser, flock, oauth-browser), and a shared-harness `it.instance` timeout pass-through.
  - PHASE 2/3/5/6: new services each shipped with tests and typecheck green (Agent Manager 6/6, Orchestration 8/8, Artifact 5/5, Model Router 8/8).

## Remaining open items

- PHASE 4 (Browser Agent) and PHASE 8 (OS sandbox): documented as limitations in `PHASE-1-diagnosis.md` §3, awaiting an explicit dependency decision.
- PHASE 10 (UI/UX + desktop): not executed; requires app/web/desktop build validation not performed in this environment.
- PHASE 11 performance harness: candidate follow-ups listed above.
- Slide WIP (`packages/core/src/tool/slide*.ts`, `packages/opencode/src/slide/**`) remains untracked per repository rules, awaiting explicit request.
