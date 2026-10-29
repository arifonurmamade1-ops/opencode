# FASE 39 — Final report

Date: 2026-10-25.
Scope: FASE 39 "Implementation by phases" (12 phases) on the current repository state.
Rules applied: FASE 40 (no fake implementations; every blocked item reported with
FEATURE/STATUS/LIMITATION/TECHNICAL REASON/WHAT WAS IMPLEMENTED/WHAT REMAINS) and FASE 41
(no deleting working code, no unnecessary public API changes, no unnecessary dependencies,
multiplatform solutions, test every relevant change).

## Phase status

| Phase | Title | Status | Evidence |
|---|---|---|---|
| 1 | Architecture + diagnosis | **Done** | `specs/fase39/PHASE-1-diagnosis.md` |
| 2 | Agent Manager + task graph | **Done** | `packages/opencode/src/agent/manager.ts` (`AgentManager.Service`), `test/agent/manager.test.ts` 6/6 |
| 3 | Multi-agent orchestration | **Done** | `packages/opencode/src/orchestration.ts` (`Orchestration.Service`), `test/orchestration.test.ts` 8/8 |
| 4 | Browser Agent | **Done** | `packages/opencode/src/browser.ts` (`Browser.Service`), `src/browser-worker.cjs`, `src/tool/browser.ts`, `test/browser.test.ts` 3/3 + `test/tool/browser.test.ts` 3/3 |
| 5 | Artifacts + verification | **Done** | `packages/opencode/src/artifact.ts` (`Artifact.Service`), `test/artifact.test.ts` 6/6 |
| 6 | Model Router + fallback | **Done** | `packages/core/src/model-router.ts` (`ModelRouter.Service`), `test/model-router.test.ts` 8/8 |
| 7 | Memory + context engine | **Done (existing core)** | `packages/core/src/memory.ts`, `system-context/*`, memory tool and context; suites green |
| 8 | Security + sandbox | **Partial (documented)** | Scanner + permissions validated (`test/security/scanner.test.ts` 25/25); OS jail blocked by native-dependency constraint. See `PHASE-8-os-sandbox.md` |
| 9 | Scheduler + remote agents | **Done (existing)** | `packages/opencode/src/scheduler/*`, server/client remote execution, sweep 32/32 |
| 10 | UI/UX + desktop | **Done (validated)** | App/desktop typecheck pass; app, desktop, and web production builds pass. See `PHASE-10-ui-desktop.md` |
| 11 | Performance | **Validated (partial coverage)** | Existing startup audit measured: `--version` 632 ms median / 55 MB RSS, `--help` 35.2 s / 235 MB; deterministic benchmark 3/3 in 67 s. Gaps (model streaming, real scheduling timing, UI rendering, CI gate) documented. See `PHASE-11-12-hardening.md` |
| 12 | Benchmark + hardening | **Done** | `packages/opencode/src/benchmark/*`, `test/benchmark/run.test.ts` 3/3; hardening and flake fixes across FASE 38–39 |

## New code and docs

- `packages/opencode/src/agent/manager.ts`
- `packages/opencode/src/orchestration.ts`
- `packages/opencode/src/artifact.ts`
- `packages/core/src/model-router.ts`
- `packages/opencode/src/browser.ts`
- `packages/opencode/src/browser-worker.cjs`
- `packages/opencode/src/tool/browser.ts`
- Tests: `packages/opencode/test/agent/manager.test.ts`, `test/orchestration.test.ts`,
  `test/artifact.test.ts`, `test/browser.test.ts`, `packages/core/test/model-router.test.ts`
- Specs: `specs/fase39/*` including this report

## Cross-cutting fixes made during validation

- **Root `package.json` strict JSON**: removed a trailing comma in the `catalog` block that broke
  Vite/esbuild config loading (`JSON does not support trailing commas`).
- **Portable custom-elements declaration**: replaced the
  `packages/app/src/custom-elements.d.ts` symlink (mode `120000`) with a regular `100644` file
  containing a `/// <reference>` to the ui package declaration. Windows checkouts with
  `core.symlinks=false` previously stored the link target as text and failed `tsgo -b` with
  `TS1128`.
- **Dashboard plural key**: added `"dashboard.agents.pending"` to the app `PluralKey` union so
  the existing dashboard call sites typecheck.

No public API was changed and no existing feature was removed.

## Validation summary

| Area | Command | Result |
|---|---|---|
| opencode typecheck | `bun run typecheck` (from `packages/opencode`) | only the known untracked slide WIP errors |
| core typecheck | `bun run typecheck` (from `packages/core`) | only the known untracked slide WIP errors |
| Agent Manager | `bun test test/agent/manager.test.ts` | 6/6 |
| Orchestration | `bun test test/orchestration.test.ts` | 8/8 |
| Artifacts | `bun test test/artifact.test.ts` | 6/6 |
| Model Router | `bun test test/model-router.test.ts` | 8/8 |
| Browser | `bun test test/browser.test.ts` | 3/3 (66s) |
| Browser tool permissions | `bun test test/tool/browser.test.ts` | 3/3 (mocked browser; 56–214s host-local) |
| Security scanner | `bun test test/security/scanner.test.ts` | 25/25 |
| Benchmark | `bun test test/benchmark/run.test.ts` | 3/3 (67.17s, 14 cases / 12 categories) |
| Startup audit | `bun run performance:audit --runs 3 --full --json` | 0 failures; `--version` 632 ms median / 55 MB RSS; `--help` 35,188 ms median / 235 MB RSS |
| App typecheck | `bun run typecheck` (from `packages/app`) | pass |
| App build | `bun run build` (from `packages/app`) | pass, 12m36s |
| App unit subset | serialize + desktop-menu + file-tree + status-popover | 27/27 |
| Desktop typecheck | `bun run typecheck` (from `packages/desktop`) | pass |
| Desktop build | `electron-vite build` (from `packages/desktop`) | pass, 4m25s with `--max-old-space-size=4096` |
| Web build | `bun run build` (from `packages/web`) | pass, 1380s server build |

Flake note: on the combined 47-test run, the first artifact test hit the default 5 s test
budget once on this 2-core host. The isolated artifact suite passed 5/5 (42 s) at the time; it is
now 6/6 after adding the id-traversal regression test.

## FASE 40 — limitations report

### PHASE 8 — real OS sandbox

- FEATURE: OS-level sandbox / filesystem jail for tool execution.
- STATUS: not implemented; documented limitation.
- LIMITATION: the repository can scan statically and gate permissions, but it cannot confine a
  process at the OS level.
- TECHNICAL REASON: `seccomp-bpf` (Linux), Job Objects/AppContainer (Windows), and
  `sandbox-exec`/Seatbelt (macOS) require native bindings or platform-specific helpers; no such
  dependency exists and FASE 41 forbids inventing one. A JavaScript-level imitation would be a
  fake sandbox.
- WHAT WAS IMPLEMENTED: existing security scanner (25/25 tests), permission policy (`allow` /
  `ask` / `deny` with overrides), MCP local-server sandbox marking, static scan exposed as the
  `security` tool.
- WHAT REMAINS: introduce a native sandbox dependency or per-OS helper behind a first-class
  `Sandbox` service consumed by shell execution. See `PHASE-8-os-sandbox.md`.

### PHASE 10 — residual environment limits

- FEATURE: runtime validation of the desktop app and fully correct local UI artifacts.
- STATUS: compile/typecheck validated; runtime launch not validated.
- LIMITATION: Electron cannot be launched from this checkout and the Windows checkout produces
  broken public image assets.
- TECHNICAL REASON: `packages/desktop/node_modules/electron/dist` has no `electron.exe`; the
  host is a 6 GB / 2-core Windows machine with `core.symlinks=false`, so the
  `packages/app/public` symlinks are checked out as text stubs. Node's default ~2 GB heap also
  OOMs the desktop/web bundles, requiring an explicit larger heap.
- WHAT WAS IMPLEMENTED: portable custom-elements reference, dashboard plural key fix, strict-JSON
  catalog fix; app/desktop typecheck and app/desktop/web production builds validated.
- WHAT REMAINS: run the full app unit suite (blocked by pre-existing i18n parity drift on this
  branch), launch/package Electron on a machine with the Electron binary, and enable git
  symlinks (or copy assets at build time) for correct Windows icons. See
  `PHASE-10-ui-desktop.md`.

### PHASE 11 — performance

- FEATURE: measured performance validation using the repository's existing harnesses.
- STATUS: validated with partial coverage; no new profiling module or CI threshold was added.
- LIMITATION: model streaming, real multi-agent scheduling under load, and UI frame timing are
  not measured by the deterministic suite; no regression gate is enforced.
- TECHNICAL REASON: benchmark cases deliberately avoid model calls so runs stay reproducible and
  free; browser DOM and TUI rendering are declared unavailable instead of estimated; defining
  production-like streaming/scheduling workloads would require an explicit workload decision.
- WHAT WAS IMPLEMENTED (measured, not invented): `bun run performance:audit --runs 3 --full
  --json` → 0 failures, `--version` median 632 ms / 55 MB peak RSS, `--help` median 35,188 ms /
  235 MB; `bun test test/benchmark/run.test.ts` → 3/3 in 67.17 s across 14 cases / 12
  categories, with JSON persistence and run comparison. Host: Windows x64, Bun 1.3.14, 6 GB RAM,
  2 logical CPUs. These are host-local observations, not superiority claims.
- WHAT REMAINS: define workloads for model streaming and multi-agent scheduling under load, add
  UI frame timing, and turn benchmark comparison into a CI threshold. See
  `PHASE-11-12-hardening.md`.

## Constraints preserved

- `bun.lock` was never staged.
- Slide WIP files (`packages/core/src/tool/slide*.ts`, `packages/opencode/src/slide/**`) remain
  untracked and untouched.
- Only the explicitly approved dependency (`playwright-core`) was added.
- Tests were run from package directories; typechecks use `bun typecheck`.

## OPENCODE EVOLUTION REPORT

### Features added

- Agent Manager with session-backed starts, listing, cancellation, and parallel fan-out.
- Multi-agent orchestration with validated dependency graphs, wave execution, skip propagation,
  and cancellation between waves.
- Artifact store with Markdown persistence and evidence-based verification against acceptance
  criteria.
- Standalone Model Router with catalog routing and fallback composition.
- Browser Agent driving headless Chromium through the `browser` tool (navigation, click, fill,
  text, title, evaluate, screenshot, page lifecycle). Screenshot writes are permission-gated and
  default to `.opencode/screenshots`.

### Features improved

- App typechecking is now portable across Windows/Linux/macOS (custom-elements reference).
- Root workspace metadata is strict JSON again, so Vite/esbuild consumers load it correctly.
- Dashboard plural call sites are typed against the shared language API.
- Orchestration rejects duplicate entries in `dependsOn` explicitly instead of reporting a false dependency cycle.
- Compatibility baseline records the additive `browser` tool, and the default-agent test disables the new `autonomous` primary agent when asserting that no primary agent remains.

### Architecture

- New services follow the existing `Context.Service` + `LayerNode` + `InstanceState` pattern and
  are additive: no public API was replaced or removed.
- Browser control is split into a Bun-side Effect service and a Node worker
  (`browser-worker.cjs`) because Chromium launching wedges under Bun; the worker communicates
  over an ephemeral localhost HTTP server and is disposed with the instance.
- Runtime dependency direction is preserved (Schema → Core/Protocol → Server; no Client → Core
  or Client → Server edges).

### Tests

- Agent Manager 6/6, orchestration 8/8, artifacts 6/6, model router 8/8, browser 3/3 +
  browser tool permissions 3/3, security scanner 25/25, benchmark 3/3, app UI subset 27/27.
- App and desktop typechecks pass; app, web, and desktop production builds pass.

### Benchmark

- Deterministic benchmark suite green (3/3) with JSON persistence and run comparison. No
  fabricated performance numbers were produced.
- Startup audit re-measured on this host: `--version` 632 ms median / 55 MB peak RSS, `--help`
  35.2 s median / 235 MB, with zero failures. Host-local baseline, not a cross-machine claim.

### Compatibility

- Validated with Bun 1.3.14 and Node 24 on Windows 11. The services are process-local and
  additive.
- The Browser Agent requires a locally installed Chromium (or
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`).

### Build instructions

- `bun install` at the repository root.
- `bun run typecheck` from `packages/app`, `packages/desktop`, `packages/opencode`, or
  `packages/core`.
- `bun run build` from `packages/app` and `packages/web`.
- `electron-vite build` from `packages/desktop` (use
  `NODE_OPTIONS=--max-old-space-size=4096` on memory-constrained hosts; `bun run build` also
  downloads the dev CLI and therefore needs network access).

### Run instructions

- Backend: `bun run ./src/index.ts serve --port 4096` from `packages/opencode`.
- Web app: `bun dev -- --port 4444` from `packages/app`, then open `http://localhost:4444`.
- Desktop: `bun run dev` from `packages/desktop` (requires the Electron binary).
- Tests: run `bun test <path>` from the owning package directory, never from the repo root.

### Limitations

- PHASE 8 OS-level sandbox requires native platform bindings (see above).
- PHASE 11 performance coverage gaps: model streaming, real multi-agent scheduling under load,
  UI frame timing, and a CI regression threshold (see above).
- PHASE 10 runtime Electron launch, Windows symlink assets, and pre-existing i18n parity drift
  (see above).

