# OpenCode Evolution Final Report

## Implemented

- Agent lifecycle and specialized agent modes: `build`, `plan`, `autonomous`, `general`, `explore`, and `security`.
- Controlled autonomous task mode with evidence-gated stages, blockers, and delivery artifacts under `.opencode/autonomous/`.
- Embedded browser panel as a viewer, with persistent per-workspace/server history and no browser automation.
- Inline editing commands (`/explain`, `/fix`, `/refactor`, `/tests`, `/docs`, `/generate`).
- Local desktop app support, including agent dashboard, inline edits, browser panel, and local/remote server selection.
- Project memory (`project`, `agent`, `task`, `session` scopes) persisted in the local project database.
- Task scheduler with immediate, one-time, interval, daily, cron, and condition schedules.
- Git intelligence tooling and a security audit agent/tool.
- Versioned plugin API, plugin inventory, validation, and compatibility loading.
- Configurable pre/post lifecycle hooks.
- MCP access policy: permissions, retry, rate limiting, trusted mode, and local-only sandboxing.
- Local telemetry aggregation tool, disabled by default.
- Transparent structured error reporting (`WHAT`, `WHY`, `WHERE`, `ATTEMPTED`, `RESULT`, `NEXT ACTION`).
- Self-diagnostics CLI `opencode doctor` and TUI `/doctor`.
- Compatibility surface audit, benchmark suite, licensing/proprietary-implementation audit, and performance audits.
- Documentation for scheduler, memory, security, browser, desktop, remote access, agents, providers, plugins, hooks, MCP, and diagnostics.

## Files changed

- `packages/opencode/src/tool/autonomous.ts`
- `packages/opencode/src/autonomous/task.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/agent/prompt/autonomous.txt`
- `packages/opencode/src/plugin/api.ts`
- `packages/opencode/src/hook/hook.ts`
- `packages/opencode/src/mcp/policy.ts`
- `packages/opencode/src/mcp/catalog.ts`
- `packages/opencode/src/security/scanner.ts`
- `packages/opencode/src/tool/security.ts`
- `packages/opencode/src/tool/schedule.ts`
- `packages/opencode/src/scheduler/scheduler.ts`
- `packages/opencode/src/scheduler/runner.ts`
- `packages/opencode/src/scheduler/schedule.ts`
- `packages/opencode/src/tool/memory.ts`
- `packages/core/src/memory.ts`
- `packages/core/src/system-context/memory-context.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/cli/cmd/doctor.ts`
- `packages/opencode/src/error/report.ts`
- `packages/core/src/tool/autonomous*.ts` support surfaces where applicable
- `packages/app/src/components/...dashboard/browser...` surfaces where applicable
- `packages/web/src/content/docs/*.mdx`
- `packages/web/astro.config.mjs`
- `README.md`

## Architecture

- Kept provider turns, throttling, permissions, tools, runner, and session orchestration in their existing layers.
- Autonomous, memory, scheduler, hooks, MCP, plugin, telemetry, diagnostics, and security support are modular and composable.
- Remote behavior is based on the existing server/client architecture; no separate cloud control plane was added.
- Browser and desktop remain product surfaces, not automation runtimes.
- No general artifact datastore was added; artifacts are Markdown files on disk.

## Tests

Relevant suites executed include:
- `packages/opencode/test/scheduler/*`
- `packages/opencode/test/autonomous/*`
- `packages/core/test/tool-memory.test.ts`
- `packages/core/test/memory.test.ts`
- `packages/core/test/system-context/memory-context.test.ts`
- `packages/opencode/test/cli/doctor.test.ts`
- `packages/opencode/test/hook/hook.test.ts`
- `packages/opencode/test/plugin/api.test.ts`
- `packages/opencode/test/mcp/policy.test.ts`
- `packages/opencode/test/error/report.test.ts`
- `packages/opencode/test/compatibility/audit.test.ts`

FASE 38 coverage expansion (all passing):
- `packages/opencode/test/mcp/browser.test.ts`: added the launcher spawn-failure branch (underlying error surfaced, no exit-code wrapper) and the 500ms grace-window branch (resolved by the grace timer when the launcher stays alive). Existing tests gained explicit 30s timeouts because this machine's cold `bun.exe` child spawns measured ~3.4s against bun's 5s default.
- `packages/opencode/test/scheduler/runner.test.ts`: added failure recording end-to-end (prompt failure is persisted as the run result, task stays enabled and re-claims) and broken-check handling (a check that cannot spawn counts as not matched and does not fire `failure` conditions, while a later healthy failing check still fires the edge).
- `packages/opencode/test/scheduler/scheduler.test.ts`: added stale running-marker reclaim after the one-hour window, failed-run state recording without wedging, and 500-char failure-report truncation.
- `packages/core/test/background-job.test.ts`: added `waitForPromotion` semantics — immediate snapshot once a job is marked background, and `Effect.never` for unknown or settled jobs so callers own the timeout.

Additional test hardening:
- Updated TaskTool Git mocks in `packages/opencode/test/tool/task.test.ts` to match the current `Git.Service` interfaces, allowing `bun typecheck` to progress to pre-existing unrelated slide WIP errors.
- Ran typechecks for `packages/opencode`.

## Failures

All failing cases recorded in this phase are now resolved except the intentionally untracked slide WIP below.

- RESOLVED — `packages/opencode/test/tool/task.test.ts`: the whole suite used to die at ToolRegistry layer build with `InstanceRef not provided`.
  - WHAT: TaskTool called `yield* InstanceState.directory` inside the tool init effect, which `ToolRegistry` fulfills eagerly while building the test layer, outside any instance context.
  - WHY: `InstanceState.context` dies when `InstanceRef` is absent; ToolRegistry build provides no instance.
  - WHERE: `packages/opencode/src/tool/task.ts` (TaskTool init), introduced by `722324c` (branch worktree support).
  - ATTEMPTED: propagating `InstanceRef` captured at init was wrong because `InstanceRef` is a `Context.Reference` with an `undefined` default — the captured value was always `undefined`. After bisecting node-by-node, the worktree directory resolution was moved from tool init into the per-run execute closure.
  - RESULT: `bun test test/tool/task.test.ts` passes 23/23, including every background-task case.
- RESOLVED — `packages/opencode/test/plugin/api.test.ts`: an unnamed subtest intermittently failed with "a beforeEach/afterEach hook timed out".
  - WHAT: the global `test/preload.ts` `afterAll` imported the heavy `app-runtime` module (~60 service modules) inside the teardown hook even for suites that never touched `AppRuntime`, pushing the hook past bun's default 5s hook timeout on slow machines.
  - WHY: bun counts a suite-level `afterAll` as an unnamed hook test and flags it as timed out.
  - WHERE: `packages/opencode/test/preload.ts`, `packages/opencode/src/effect/app-runtime.ts`.
  - ATTEMPTED: added `src/effect/app-runtime-usage.ts` usage latch; `AppRuntime.run*` entries mark usage, and the preload `afterAll` only imports/disposes `AppRuntime` when used.
  - RESULT: `bun test test/plugin/api.test.ts` passes 19/19, and the failure no longer reproduces on minimal probe files either.
- REMAINING — `bun typecheck` in `packages/opencode` is still blocked by known, untracked slide WIP:
  - `packages/core/src/tool/slide.ts`
  - `packages/core/src/tool/slide-node.ts`
  - `packages/opencode/src/slide/**`
- Full opencode typecheck also references pre-existing slide WIP expectations elsewhere in the repository.

These outcomes are documented rather than masked or faked.

## Fixes

- Resolved the whole-suite `InstanceRef not provided` die in `packages/opencode/test/tool/task.test.ts` by resolving the TaskTool worktree directory per run instead of inside the eagerly built tool init.
- Resolved the intermittent unnamed hook timeout by making the preload `afterAll` import/dispose `AppRuntime` only when the suite actually used it (`src/effect/app-runtime-usage.ts`).
- Corrected Git test mock typing and cast the mocked object to the current Git interface.
- Kept slide WIP uncommitted and unstaged per repository rules.
- Restored documentation claims to implemented behavior only.
- Fixed MCP timeout documentation default from 5s to 30s.
- Corrected hooks commit-stage documentation wording.
- Made the FASE 38 browser launcher tests robust on slow hosts: measured cold `bun.exe` child spawns at ~3.4s exceed bun's 5s default test timeout, so the browser tests carry explicit 30s timeouts, and the launcher `error` branch uses a deterministic event emitter instead of racing real spawn failure timing.

## Performance

- No broad rewrite or replacement of orchestration paths was performed.
- New capabilities were added through focused modules, preserving existing CLI/TUI behavior.
- Scheduler polling remains 15 seconds; conditional checks default to 5 minutes.
- Memory context remains capped at 40 entries and approximately 500 tokens.

## Security

- Permissions remain `allow`, `ask`, or `deny`, with agent and wildcard overrides.
- Non-loopback server binds still require `OPENCODE_SERVER_PASSWORD`.
- MCP sandboxing is local working-directory/environment reduction, not an OS sandbox or filesystem jail.
- Security scanner is deterministic static analysis and heuristics, not a CVE database, exploit engine, or full security proof.
- Autonomous, browser, memory, and scheduler behavior do not bypass permissions or enable background runtime execution outside the OpenCode process.

## Known limitations

- Plugin API v1 is additive and only supports this build's declared version.
- Scheduler tasks only run while the project/server is open in the OpenCode process; missed runs are not replayed one-by-one.
- Browser panel cannot be controlled by the agent and cannot bypass site embedding or authentication.
- Desktop notifications, attachments, and voice features remain platform/browser-capability dependent rather than fully universal controls.
- Remote access has no cloud relay, dedicated control plane, mobile app guarantees, TLS, or RBAC.
- Telemetry is local-only, disabled by default, and computed on demand.
- Artifacts are individual Markdown files, not a general artifact browser or dashboard.
- Two pre-existing test failures are resolved; slide WIP typecheck failures remain and slide WIP stays untracked.
- Localized, non-English documentation directories were intentionally not updated; English web docs were updated only.

## Next phase

No further roadmap phase is marked complete from this commit set beyond the implemented features above. Open work items:
1. ~~Repair `InstanceRef` propagation in `packages/opencode/test/tool/task.test.ts` background cancellation tests.~~ Done: the tool init no longer requires an instance; the worktree directory resolves per run and the suite passes 23/23.
2. ~~Address the intermittent `packages/opencode/test/plugin/api.test.ts` hook timeout.~~ Done: the preload `afterAll` only imports/disposes `AppRuntime` when the suite used it; the suite passes 19/19.
3. Remove or complete the slide WIP (`packages/core/src/tool/slide*.ts`, `packages/opencode/src/slide/**`) only when explicitly requested.
4. ~~Continue expanding automated tests for browser, remote execution, provider retry behavior, and recovery paths.~~ Done: gap analysis found provider retry/fallback/escalation, interrupted-tool recovery, crash-scope job interruption, and remote exposure/auth already covered; added browser launcher error/grace branches, scheduler failed-run + broken-check recovery, stale running-marker reclaim, report truncation, and background-job `waitForPromotion` semantics. All suites pass; typecheck clean except the known untracked slide WIP.