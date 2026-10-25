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
| 1 | Architecture + diagnosis | In progress (this doc) | Baseline established. |
| 2 | Agent Manager + task graph | **Done (PHASE 2)** | Task graph: `autonomous/task.ts` (pure state machine). Agent registry: `agent/agent.ts`. **New**: `agent/manager.ts` (`AgentManager.Service`) — start/list/get/cancel/runAll/runForTask, per-instance registry, session-backed execution, parallel fan-out, evidence-friendly RunInfo. Limitations documented in `PHASE-2-agent-manager.md`. |
| 3 | Multi-agent orchestration | **Done (PHASE 3)** | New service: `packages/opencode/src/orchestration.ts` (`Orchestration.Service`) — plan validation (unique/known/self/cycle), wave-based parallel execution via AgentManager, skip propagation on failed deps, fan-out/fan-in via `dependsOn`, cancellation between waves, per-instance run registry. Tests: `packages/opencode/test/orchestration.test.ts` (8/8). Limitations: inline waves (no mid-flight cancel), no explicit fan-in aggregator, process-local. |
| 4 | Browser Agent | **Done (PHASE 4)** | Implemented with playwright-core via packages/opencode/src/browser.ts (Browser.Service) plus agent tool packages/opencode/src/tool/browser.ts. Tests: packages/opencode/test/browser.test.ts (3/3). Backend uses Node child process because Chromium launching wedges under Bun. |
| 5 | Artifacts + verification | **Done (PHASE 5)** | New service: `packages/opencode/src/artifact.ts` (`Artifact.Service`) — `dir/list/read/write/verify`, filesystem-backed index over `.opencode/artifacts/*.md`, evidence-based verification against acceptance criteria. Tests: `packages/opencode/test/artifact.test.ts` (5/5). Limitations: individual Markdown files (not a general browser/dashboard); verification is substring/evidence based, not semantic. |
| 6 | Model Router + fallback | **Done (PHASE 6)** | Standalone service: `packages/core/src/model-router.ts` (`ModelRouter.Service`) — `route`/`routeFromCatalog`/`next`/`withFallback`, reusing `ModelFallback.order`/`nextAlternative`/`withFallback` and `SessionRunnerModel.supported`. Tests: `packages/core/test/model-router.test.ts` (8/8). Limitations: capability/cost/latency policy beyond free-first + preferred is a follow-up. |
| 7 | Memory + context engine | **Done (core)** | `packages/core/src/memory.ts` (list/save/remove, project-scoped), `system-context/*`, memory context (capped 40 entries / ~500 tokens). Memory tool in core. Tests: `memory.test.ts`, `tool-memory.test.ts`, `memory-context.test.ts`, `memory-command.test.ts`. |
| 8 | Security + sandbox | **Partial (documented)** | Existing security scanner, permission policy, MCP sandbox marking. OS-level jail not feasible without native deps (FASE 40). See specs/fase39/PHASE-8-os-sandbox.md. |
| 9 | Scheduler + remote agents | **Done (core + opencode)** | Scheduler: `packages/opencode/src/scheduler/{scheduler,runner,schedule}.ts` with durable tasks, condition checks, stale-running reclaim, truncation. Remote execution: server/client architecture (`server/*`, `control-plane`), remote-guard tests, auth. Tests comprehensive (sweep: 32/32). |
| 10 | UI/UX + desktop | **Not validated (FASE 40)** | App/web/desktop packages exist. `bun run typecheck` in `packages/app` is blocked on this Windows host by `src/custom-elements.d.ts` being committed as a symlink-as-text file (contents = `../../ui/src/custom-elements.d.ts`, git mode 100644) which tsgo rejects (TS1128). Confirmed pre-existing and unrelated to this arc. Details: `specs/fase39/PHASE-10-ui-desktop.md`. |
| 11 | Performance | **Partial (documented)** | Existing: telemetry module (`packages/opencode/src/telemetry.ts`), benchmark cases. No dedicated performance harness or profiling added in this arc — FASE 40 applies: a perf module would have to be backed by measured workloads, and none are defined beyond the benchmark suite. See `PHASE-11-12-hardening.md`. |
| 12 | Benchmark + hardening | **Done (validated)** | Benchmark service exists and green: `packages/opencode/src/benchmark/*` (deterministic cases, JSON persistence under global data dir, run comparison), tool registered in `tool/registry.ts`; `bun test test/benchmark/run.test.ts` 3/3 pass. Hardening across the arc: FASE 38 coverage (browser, scheduler, recovery, provider retry, background-job promotion semantics), FASE 39 sweep fixing `EffectFlock` lock-root recreation and slow-host budgets, plus this phase's validation. |

## 3. Gaps requiring decisions (FASE 40)

- **PHASE 4 Browser Agent**: implemented with playwright-core (explicit dependency decision approved by the user). Real service Browser.Service, agent tool rowser, integration tests. See specs/fase39/PHASE-4-browser-agent.md.
- **PHASE 8 OS sandbox**: documented as limitation (no native OS bindings). Static scanner + permission policy is the honest scope. See specs/fase39/PHASE-8-os-sandbox.md.
- **PHASE 5 general artifact store**: could be implemented (Markdown files on disk already exist for autonomous tasks) — small, scoped, recommended.
- **PHASE 2 Agent Manager**: implementable as a service composing existing `agent/agent.ts` + `autonomous/task.ts` + session runner — recommended next.
- **PHASE 6 standalone Model Router**: implementable as a service over `SessionRunnerModel` + `ModelFallback` — medium scope.

## 4. Recommended execution order

1. PHASE 2 — Agent Manager + task graph (foundation; task graph already exists as pure module).
2. PHASE 6 — Model Router + fallback (composes existing fallback).
3. PHASE 5 — Artifacts + verification (small, builds on autonomous task).
4. PHASE 3 — Multi-agent orchestration (depends on 2).
5. PHASE 11/12 — Performance + benchmark + hardening (last, after features stable).

PHASE 8: keep as documented limitation unless an explicit dependency decision is made.

## 5. Constraints carried forward

- No new dependencies (FASE 41 #5).
- Never stage `bun.lock` or slide WIP (`packages/core/src/tool/slide*.ts`, `packages/opencode/src/slide/**`).
- Run tests from package dirs; typecheck via `bun typecheck`.
- Conventional commits; push `--no-verify fork task-worktree`.
- After each phase: compile, run tests, fix errors, validate regressions, update docs.
- FASE 40 reporting for anything that cannot be implemented.

## 6. Next action

Awaiting explicit go for PHASE 2 (Agent Manager + task graph). No code changes in this phase beyond this diagnosis document.
