# FASE 39 — PHASE 2: Agent Manager + task graph

Date: 2026-10-24 (post PHASE 1 diagnosis, commit `bd0875b`).
Scope: implement the missing "Agent Manager" that owns agent run lifecycle and composes with the existing task graph (`autonomous/task.ts`) and agent registry (`agent/agent.ts`).

## What was implemented

- New service: `packages/opencode/src/agent/manager.ts` (`AgentManager.Service`, `@opencode/AgentManager`).
  - `start({ agent, prompt, taskID? })` — resolves the agent first (unknown agent fails as a defect before any session is created; `Agent.get` has no typed error today), creates a session titled `agent: <name>`, prompts the agent, records per-run status (`running` → `completed`/`failed`) with session id, output summary (first 500 chars of the assistant parts) or error (`Cause.pretty`).
  - `list()` / `get(id)` — process-local registry scoped per instance directory (via `InstanceState`).
  - `cancel(id)` — flips `pending`/`running` runs to `cancelled` (see limitations).
  - `runAll({ agent, prompts })` — parallel fan-out with `concurrency: "unbounded"`, one `RunInfo` per prompt.
  - `runForTask({ agent, taskID, objective })` — runs an agent for an autonomous task objective, carrying the task id on the run.
- The autonomous task graph (`autonomous/task.ts`) stays pure: the manager does not mutate task state. Callers update stages (`agents`/`implement`) from the returned `RunInfo` (success → done with evidence = session id + output; failure → block). This preserves the evidence-gated delivery contract.
- Layer: `AgentManager.node` depends on `Agent.node`, `Session.node`, `SessionPrompt.node` (same shape as the scheduler runner).

## Tests

- `packages/opencode/test/agent/manager.test.ts` — 6/6 pass (54s):
  - complete run (status, session id, output, registry, get/list)
  - failed run (prompt failure → `failed`, error, session id retained, output absent, completedAt)
  - parallel `runAll` (3 runs, all completed, list length 3)
  - unknown run → `get`/`cancel` return undefined
  - agent resolution happens before session creation (unknown agent → defect, no session, no prompt)
  - `runForTask` carries `taskID` and prompt

## Limitations (FASE 40)

- Runs are awaited inline; `cancel` cannot interrupt an in-flight run (no forked fiber + scope). Forked, cancellable runs with cancellation propagation are a documented follow-up.
- Output is summarized to 500 chars; full transcript lives in the session.
- The manager does not persist runs (process-local, per instance directory) and does not itself advance autonomous task stages — callers apply stage updates from the returned `RunInfo` to keep the task state machine pure.
- No dependency graph between agents (fan-out only); fan-in/aggregation of multiple agents' outputs into a single task stage is left to the caller.

## Validation

- `bun test test/agent/manager.test.ts` → 6/6 pass.
- `bun typecheck` (packages/opencode) → only the known untracked slide WIP errors.

## Next action

PHASE 3 (multi-agent orchestration) builds on this manager: task dependencies, fan-out/fan-in, and cancellation propagation across agents. Awaiting explicit go.
