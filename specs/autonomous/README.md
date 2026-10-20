# Controlled autonomous tasks

FASE 34 adds an opt-in `autonomous` mode. It is a primary agent with a dedicated
state tool, not a background job: the normal session still owns the model calls,
permissions, and tool execution.

## Usage

```sh
opencode run --autonomous "Create complete authentication and deliver it working"
```

`--autonomous` is equivalent to `--agent autonomous`. It cannot be combined with
a different `--agent`. Attended runs keep the normal permission prompts; add
`--auto` only when you intentionally want the run to proceed without them.

In the TUI, select the `autonomous` agent from the agent picker.

## What is enforced

The agent must call `autonomous_task` before doing the work and record evidence
for each tracked stage:

1. `understand`
2. `research`
3. `plan`
4. `agents`
5. `implement`
6. `run`
7. `test`
8. `browser`
9. `fix`
10. `security`
11. `diff`
12. `artifact`

Delivery is the final action (`action: "deliver"`), not a separate tracked stage.

`understand`, `plan`, `implement`, `test`, `security`, and `diff` must be marked
`done`, and a done stage needs concrete evidence (a command and result, a file
path, a URL, or a finding). `research`, `agents`, `run`, `browser`, and `fix` may
be skipped, but only with an explicit reason.

`autonomous_task` with `action: "deliver"` refuses to write a delivered artifact
while any stage is pending or blocked, or while a required stage was skipped.

## BLOCKED

A real blocker is recorded with `action: "block"`, including `what`, `why`, and
`needs`. The tool writes the artifact immediately and the agent must stop. The
final response starts with `BLOCKED` and explains the exact cause. A blocked task
is never reported as delivered. Resolving the blocker and updating the stage
clears the blocked state so the task can continue.

## Artifact

The delivery record is written to `.opencode/autonomous/<task-id>.md` in the
project directory. It contains the objective, acceptance criteria, every stage
with its evidence, any blocker, and the delivery timestamp. Runtime state lives
in the OpenCode data directory, keyed by session, so it does not add files to the
repository.

## Scope and safety

- The mode does not auto-approve tools, commit, or push. Those remain explicit
  user decisions.
- The `autonomous_task` tool is only visible to the `autonomous` agent.
- Subagents are launched through the existing `task` tool (`explore`, `general`,
  `security`); no new agent runtime is introduced.
- Browser verification uses an available browser tool or MCP server. If neither
  exists, the stage must be skipped with that reason rather than claimed.

## Verification

```sh
cd packages/opencode
bun test test/autonomous test/agent/agent.test.ts test/tool/registry.test.ts
```

The state machine has deterministic tests for evidence gates, required stages,
blockers, artifact rendering, and delivery. The tool tests cover the persisted
state and both delivered and blocked artifacts.
