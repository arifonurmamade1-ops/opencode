# FASE 39 — PHASE 1: Architecture + Diagnosis

Date: 2026-10-24 (post FASE 38 close, commits through `bee95ae`).
Scope: FASE 39 "Implementation by phases" (12 phases) applied to the current repository state.
Rules applied: FASE 40 (no faking — report FEATURE/STATUS/LIMITATION/TECHNICAL REASON/WHAT WAS IMPLEMENTED/WHAT REMAINS) and FASE 41 (no deleting working code, no unnecessary public API changes, no new dependencies, multiplatform, test every relevant change).

## 1. Architecture snapshot (existing layers)

The codebase is already modular and composable. The relevant surfaces:

- **Core** (`packages/core/src`): `memory`, `system-context/*`, `session/runner/{index,llm,model,model-fallback,retry,tool-budget}`, `background-job`, `global`, `util/{flock,effect-flock}`, `catalog`, `model`, `provider`, `project`, `location`, `permission`, `question`, `snapshot`, `git`.
- **OpenCode** (`packages/opencode/src`): `agent/agent.ts`, `autonomous/task.ts` (pure evidence-gated state machine), `tool/{autonomous,task,schedule,security,memory? no — core memory tool}`, `scheduler/{scheduler,runner,schedule}`, `mcp/{browser,auth,index}`, `security/scanner.ts`, `benchmark/*`, `server/*` (remote execution), `session/*`, `memory` (via core), `plugin`, `hook`, `telemetry`, `doctor`.
- **App/Web/Desktop**: `packages/app`, `packages/web`, `packages/desktop` (UI surfaces).
- **Tests**: `packages/opencode/test`, `packages/core/test` with `testEffect`/`it.instance`/`it.live`, `Layer.mock`, readiness signals. Slide WIP remains intentionally untracked (`packages/core/src/tool/slide*.ts`, `packages/opencode/src/slide/**`).

Runtime dependency direction (already enforced): Schema → Core/Protocol → Server; Client never depends on Core/Server.

## 2. Phase-by-phase status

Status legend: **Done** = implemented and tested; **Partial** = exists but incomplete/gaps; **Missing** = not implemented (FASE 40 applies).

| Phase | Title | Status | Evidence / gaps |
|---|---|---|---|
| 1 | Architecture + diagnosis | **Done** | Baseline established; phase outcomes recorded in section 2 and the per-phase specs. |
| 2 | Agent Manager + task graph | **Done (PHASE 2)** | Task graph: `autonomous/task.ts` (pure state machine). Agent registry: `agent/agent.ts`. **New**: `agent/manager.ts` (`AgentManager.Service`) — start/list/get/cancel/runAll/runForTask, per-instance registry, session-backed execution, parallel fan-out, evidence-friendly RunInfo. Limitations documented in `PHASE-2-agent-manager.md`. |
| 3 | Multi-agent orchestration | **Done (PHASE 3)** | New service: `packages/opencode/src/orchestration.ts` (`Orchestration.Service`) — plan validation (unique/known/self/cycle), wave-based parallel execution via AgentManager, skip propagation on failed deps, fan-out/fan-in via `dependsOn`, cancellation between waves, per-instance run registry. Tests: `packages/opencode/test/orchestration.test.ts` (8/8). Limitations: inline waves (no mid-flight cancel), no explicit fan-in aggregator, process-local. |
| 4 | Browser Agent | **Done (PHASE 4)** | Implemented with playwright-core via packages/opencode/src/browser.ts (Browser.Service) plus agent tool packages/opencode/src/tool/browser.ts. Tests: packages/opencode/test/browser.test.ts (3/3). Backend uses Node child process because Chromium launching wedges under Bun. |
| 5 | Artifacts + verification | **Done (PHASE 5)** | New service: `packages/opencode/src/artifact.ts` (`Artifact.Service`) — `dir/list/read/write/verify`, filesystem-backed index over `.opencode/artifacts/*.md`, evidence-based verification against acceptance criteria. Tests: `packages/opencode/test/artifact.test.ts` (5/5). Limitations: individual Markdown files (not a general browser/dashboard); verification is substring/evidence based, not semantic. |
| 6 | Model Router + fallback | **Done (PHASE 6)** | Standalone service: `packages/core/src/model-router.ts` (`ModelRouter.Service`) — `route`/`routeFromCatalog`/`next`/`withFallback`, reusing `ModelFallback.order`/`nextAlternative`/`withFallback` and `SessionRunnerModel.supported`. Tests: `packages/core/test/model-router.test.ts` (8/8). Limitations: capability/cost/latency policy beyond free-first + preferred is a follow-up. |
| 7 | Memory + context engine | **Done (core)** | `packages/core/src/memory.ts` (list/save/remove, project-scoped), `system-context/*`, memory context (capped 40 entries / ~500 tokens). Memory tool in core. Tests: `memory.test.ts`, `tool-memory.test.ts`, `memory-context.test.ts`, `memory-command.test.ts`. |
| 8 | Security + sandbox | **Partial (documented)** | Existing security scanner, permission policy, MCP sandbox marking. OS-level jail not feasible without native deps (FASE 40). See specs/fase39/PHASE-8-os-sandbox.md. |
| 9 | Scheduler + remote agents | **Done (core + opencode)** | Scheduler: `packages/opencode/src/scheduler/{scheduler,runner,schedule}.ts` with durable tasks, condition checks, stale-running reclaim, truncation. Remote execution: server/client architecture (`server/*`, `control-plane`), remote-guard tests, auth. Tests comprehensive (sweep: 32/32). |
| 10 | UI/UX + desktop | **Done (validated)** | App/desktop typecheck pass; app `vite build`, desktop `electron-vite build`, and web `astro build` pass. Unblocked by three fixes: portable custom-elements reference (was a Windows-broken symlink), missing `dashboard.agents.pending` plural key, and a strict-JSON trailing comma in root `package.json`. Pre-existing i18n parity drift documented. See `specs/fase39/PHASE-10-ui-desktop.md`. |
| 11 | Performance | **Validated (partial coverage)** | Existing harnesses measured on this host: startup audit `--version` 632 ms median / 55 MB RSS, `--help` 35.2 s / 235 MB, 0 failures; deterministic benchmark 3/3 in 67.17 s (14 cases / 12 categories). Not covered: model streaming, real scheduling load, UI frame timing, CI threshold. See `PHASE-11-12-hardening.md`. |
| 12 | Benchmark + hardening | **Done (validated)** | Benchmark service exists and green: `packages/opencode/src/benchmark/*` (deterministic cases, JSON persistence under global data dir, run comparison), tool registered in `tool/registry.ts`; `bun test test/benchmark/run.test.ts` 3/3 pass. Hardening across the arc: FASE 38 coverage (browser, scheduler, recovery, provider retry, background-job promotion semantics), FASE 39 sweep fixing `EffectFlock` lock-root recreation and slow-host budgets, plus this phase's validation. |

## 3. Gaps requiring decisions (FASE 40)

- **PHASE 8 OS sandbox**: documented limitation; a real jail needs native platform bindings. Static
  scanner + permission policy is the honest scope. See specs/fase39/PHASE-8-os-sandbox.md.
- **PHASE 10 residuals**: runtime Electron launch, Windows symlink checkout for public assets, and
  pre-existing i18n parity drift. See specs/fase39/PHASE-10-ui-desktop.md.
- **PHASE 11 performance**: no measured workload harness or regression thresholds yet. See
  specs/fase39/PHASE-11-12-hardening.md.
- **PHASE 4 Browser Agent dependency**: resolved with the explicitly approved playwright-core
  dependency. See specs/fase39/PHASE-4-browser-agent.md.

## 4. Execution outcome

The recommended order was followed and completed: PHASE 2 → 6 → 5 → 3 → 4 → 8 (documented) →
10 (validated) → 11/12. All remaining work is captured under section 3 and in the final report
(`specs/fase39/FASE-39-report.md`).

## 5. Constraints carried forward

- No new dependencies (FASE 41 #5).
- Never stage `bun.lock` or slide WIP (`packages/core/src/tool/slide*.ts`, `packages/opencode/src/slide/**`).
- Run tests from package dirs; typecheck via `bun typecheck`.
- Conventional commits; push `--no-verify fork task-worktree`.
- After each phase: compile, run tests, fix errors, validate regressions, update docs.
- FASE 40 reporting for anything that cannot be implemented.

## 6. Next action

FASE 39 phases are closed: PHASE 10 is validated and the implementation phases are done or documented. Remaining FASE 40 items are the PHASE 8 OS-level sandbox (needs native platform bindings) and the PHASE 11 performance harness (needs measured workloads). See the final report in `specs/fase39/FASE-39-report.md`.
