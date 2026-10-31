# FASE 39 — PHASES 11 & 12: Performance, Benchmark + hardening

Date: 2026-10-24 (post PHASE 3, commit `f1928fd`).

## PHASE 11 — Performance

Status: **Validated with existing harnesses (partial coverage)**.

Measured on 2026-10-25 on Windows x64, Bun 1.3.14, 6 GB RAM / 2 logical CPUs,
after one warmup per command:

| Command | Median wall | Min | Max | Median CPU | Median peak RSS |
|---|---:|---:|---:|---:|---:|
| `opencode --version` | 632 ms | 549 ms | 667 ms | 625 ms | 55 MB |
| `opencode --help` (full command tree) | 35,188 ms | 31,079 ms | 43,323 ms | 7,625 ms | 235 MB |

Command: `bun run performance:audit --runs 3 --full --json` → 0 failures. `--version` stays on
the lightweight bootstrap path; `--help` loads the complete command tree, so its wall time is
dominated by module loading (7.6 s CPU; the remainder is I/O, initialization, and host
scheduling on this 2-core machine).

Functional measurement: `bun test test/benchmark/run.test.ts` → **3/3 pass in 67.17 s**,
covering the full deterministic suite (14 cases / 12 categories), JSON persistence, run
comparison, and repeated sampling. Each case records a real `duration_ms` for the operation it
exercises.

Coverage honesty:

- **Measured:** startup wall/CPU/RSS; functional latency for editing, debugging, refactoring,
  fetch/extract, multi-agent catalog contracts, long-running background jobs, retry/recovery,
  context ranking/compression, permissions, MCP policy, routing availability, and
  truncation/cost budgets.
- **Declared unavailable by the suite (never estimated):** real browser DOM interaction and TUI
  rendering.
- **Not covered:** model streaming latency/throughput (benchmark cases never call a model), real
  multi-agent scheduling under load (`AgentManager`/`Orchestration` have functional tests but no
  timing cases), and UI frame timing.
- **No CI latency-regression gate** was added. The startup audit has a coarse 15 s version budget
  (`--check`); benchmark run comparison exists but is not enforced in CI. Comparison does guard
  against false evidence: `compareRuns` records `comparability`, and `formatComparison` marks
  deltas from different platforms, architectures, or Bun versions as non-comparable.

Per FASE 40, these numbers are host-local observations, not claims of product superiority. The
existing telemetry module (`packages/opencode/src/telemetry.ts`) remains the runtime source for
production timings.

## PHASE 12 — Benchmark + hardening

Status: **Done (validated)**.

- Benchmark service exists (`packages/opencode/src/benchmark/{benchmark,cases,report}.ts`) with a static case catalog, in-process execution with a 60s per-case timeout, JSON persistence, listing, get, and comparison. Registered as a tool in `packages/opencode/src/tool/registry.ts` via `Benchmark.node`.
- `bun test test/benchmark/run.test.ts` → 3/3 pass (55s).
- Hardening delivered across this arc:
  - FASE 38: browser launcher error/grace coverage, scheduler failed-run + broken-check recovery, stale running-marker reclaim, report truncation, background-job `waitForPromotion` semantics, provider-retry coverage audited (already present).
  - FASE 39 sweep: fixed `EffectFlock` lock-root recreation after state-dir wipe (real production bug), resolved slow-host budgets (browser, flock, oauth-browser), and a shared-harness `it.instance` timeout pass-through.
  - Benchmark comparison hardening: `compareEnvironments`/`Comparison.comparability` expose platform, arch, and Bun differences, and `formatComparison` renders mixed-environment deltas as non-comparable. Covered by `test/benchmark/report.test.ts` (8/8).
  - PHASE 2/3/5/6: new services each shipped with tests and typecheck green (Agent Manager 6/6, Orchestration 8/8, Artifact 5/5, Model Router 8/8).

## Remaining open items

- PHASE 4 (Browser Agent): implemented with the explicitly approved `playwright-core` dependency.
  See `PHASE-4-browser-agent.md`; no dependency decision remains.
- PHASE 8 (OS sandbox): documented limitation; a real OS jail needs native platform bindings.
  See `PHASE-8-os-sandbox.md`.
- PHASE 10 (UI/UX + desktop): validated for typecheck and production builds. Residual environment
  limits (runtime Electron, Windows symlink assets, i18n parity) are in `PHASE-10-ui-desktop.md`.
- PHASE 11 performance coverage: model streaming, real multi-agent scheduling under load, UI
  frame timing, and a CI regression threshold remain open (see above).
- Slide WIP (`packages/core/src/tool/slide*.ts`, `packages/opencode/src/slide/**`) remains untracked per repository rules, awaiting explicit request.
