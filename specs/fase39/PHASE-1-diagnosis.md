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
| 3 | Multi-agent orchestration | **Partial** | Subagent support + `TaskTool` + parallel `Effect.forEach` in scheduler. Missing: a first-class orchestration layer with task dependencies, fan-out/fan-in, and cancellation propagation across agents. |
| 4 | Browser Agent | **Missing (as an agent)** | Browser exists as a surface: `packages/opencode/src/mcp/browser.ts` (`McpBrowser`), browser panel, browser tests. There is **no** autonomous Browser Agent tool that drives a browser session as part of a task. FASE 40 limitation applies if attempted without a real browser driver. |
| 5 | Artifacts + verification | **Partial** | `autonomous/task.ts` carries `artifactPath` and delivery gating; `tool/autonomous.ts` persists. **Missing**: a general artifact store/index (no `artifact*` module anywhere) and a verification runner that checks artifacts against acceptance criteria. |
| 6 | Model Router + fallback | **Partial** | Fallback chain exists: `packages/core/src/session/runner/model-fallback.ts` (free-first, release-descending). Model resolution: `packages/core/src/session/runner/model.ts` (`SessionRunnerModel`). **Missing**: a standalone Model Router service selecting models by capability/cost/latency policy independent of a session turn. |
| 7 | Memory + context engine | **Done (core)** | `packages/core/src/memory.ts` (list/save/remove, project-scoped), `system-context/*`, memory context (capped 40 entries / ~500 tokens). Memory tool in core. Tests: `memory.test.ts`, `tool-memory.test.ts`, `memory-context.test.ts`, `memory-command.test.ts`. |
| 8 | Security + sandbox | **Partial** | Security scanner: `packages/opencode/src/security/scanner.ts`, `tool/security.ts`. Permissions: `allow/ask/deny` with agent + wildcard overrides. Non-loopback binds require `OPENCODE_SERVER_PASSWORD`. **Missing**: an OS-level sandbox/filesystem jail (scanner is static heuristics; MCP sandboxing is working-dir/env reduction only, documented as not an OS sandbox). |
| 9 | Scheduler + remote agents | **Done (core + opencode)** | Scheduler: `packages/opencode/src/scheduler/{scheduler,runner,schedule}.ts` with durable tasks, condition checks, stale-running reclaim, truncation. Remote execution: server/client architecture (`server/*`, `control-plane`), remote-guard tests, auth. Tests comprehensive (sweep: 32/32). |
| 10 | UI/UX + desktop | **Partial** | App/web/desktop packages exist; TUI. No dedicated phase work beyond existing surfaces. |
| 11 | Performance | **Partial** | `packages/opencode/src/benchmark/*` (cases/report). No systematic perf harness documented for the new subsystems. |
| 12 | Benchmark + hardening | **Partial** | Benchmark module exists; hardening = FASE 38 tests (done) + this diagnosis. |

## 3. Gaps requiring decisions (FASE 40)

- **PHASE 4 Browser Agent**: cannot be implemented as a real browser-driving agent without a browser automation driver (Playwright/Puppeteer) — not a dependency today and FASE 41 forbids unnecessary deps. Implementing it as a "browser panel cannot be controlled by the agent" (already documented limitation) is the honest scope. A future implementation needs an explicit dependency decision.
- **PHASE 8 OS sandbox**: cannot be a real OS jail without platform-specific sandboxing (seccomp/Job Objects/AppContainer) — out of scope for a cross-platform TS change without native deps. Static scanner + permission policy is the honest scope.
- **PHASE 5 general artifact store**: could be implemented (Markdown files on disk already exist for autonomous tasks) — small, scoped, recommended.
- **PHASE 2 Agent Manager**: implementable as a service composing existing `agent/agent.ts` + `autonomous/task.ts` + session runner — recommended next.
- **PHASE 6 standalone Model Router**: implementable as a service over `SessionRunnerModel` + `ModelFallback` — medium scope.

## 4. Recommended execution order

1. PHASE 2 — Agent Manager + task graph (foundation; task graph already exists as pure module).
2. PHASE 6 — Model Router + fallback (composes existing fallback).
3. PHASE 5 — Artifacts + verification (small, builds on autonomous task).
4. PHASE 3 — Multi-agent orchestration (depends on 2).
5. PHASE 11/12 — Performance + benchmark + hardening (last, after features stable).

PHASE 4, 8: keep as documented limitations unless an explicit dependency decision is made.

## 5. Constraints carried forward

- No new dependencies (FASE 41 #5).
- Never stage `bun.lock` or slide WIP (`packages/core/src/tool/slide*.ts`, `packages/opencode/src/slide/**`).
- Run tests from package dirs; typecheck via `bun typecheck`.
- Conventional commits; push `--no-verify fork task-worktree`.
- After each phase: compile, run tests, fix errors, validate regressions, update docs.
- FASE 40 reporting for anything that cannot be implemented.

## 6. Next action

Awaiting explicit go for PHASE 2 (Agent Manager + task graph). No code changes in this phase beyond this diagnosis document.
