# Compatibility contract

FASE 32 keeps the existing commands, configurations, agents, plugins, MCP
servers, providers, workflows, scripts, API, CLI, and TUI behavior available
across releases. This directory holds the machine-readable baseline and the
waivers for intentional breaking changes.

The guard has two layers:

- `specs/compatibility/baseline.json` records the public surfaces of the tree.
- `specs/compatibility/waivers.json` records accepted breaking changes with a
  reason, a migration, and tests.

`packages/opencode/script/compatibility-audit.ts` extracts the current surfaces,
compares them with the baseline, and validates the waivers. CI runs it on every
push.

## What is covered

| Surface                             | Snapshot                                                                          | Breaking when                   |
| ----------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| CLI commands, aliases, global flags | top-level commands in `packages/opencode/src/cli/main.ts`, flags registered there | removed                         |
| CLI subcommands and command flags   | `command:` and `.option(...)` in `packages/opencode/src/cli/cmd/**`               | removed                         |
| Config keys                         | top-level fields of `ConfigV1.Info`                                               | removed                         |
| Agent config fields                 | fields of `ConfigAgentV1.Info`                                                    | removed                         |
| MCP config fields                   | fields of `ConfigMCPV1.Local` and `ConfigMCPV1.Remote`                            | removed                         |
| Built-in agents                     | names in `packages/opencode/src/agent/agent.ts`                                   | removed                         |
| Built-in tools                      | ids from `Tool.define(...)` in `packages/opencode/src/tool/**`                    | removed                         |
| Plugin API                          | `PLUGIN_API_VERSION` and the `Hooks` interface in `packages/plugin`               | removed hook, changed version   |
| TUI config                          | fields of the `TuiConfig.Info` schema                                             | removed                         |
| TUI keybinds                        | actions and defaults in `TuiKeybind.Definitions`                                  | removed action, changed default |
| HTTP API                            | `METHOD /path` from `OpenCodeHttpApi`                                             | removed                         |
| Root workflow scripts               | `scripts` in the root `package.json`                                              | removed                         |

Providers, models, and their capabilities are dynamic data from models.dev, so
they are not frozen in the baseline. Provider configuration itself is covered by
the config schema.

Not covered: help/description text, themes and visual assets, generated SDK
types (checked by `packages/client`'s `check:generated`), and internal modules
that are not part of the surfaces above. Nested config beyond the agent and MCP
shapes is intentionally left out of this first contract.

## Running

From the repository root:

```sh
bun run compatibility:audit          # CI mode
bun run compatibility:audit --json   # machine-readable report
bun run compatibility:audit --update # accept the current tree as the baseline
```

Run the tests from `packages/opencode`:

```sh
bun test test/compatibility --timeout 120000
```

Exit codes:

- `0`: the tree matches the baseline.
- `1`: breaking change without a valid waiver, or an invalid waiver.
- `2`: the baseline is stale (compatible additions or an accepted change that
  still needs `--update`).

The unit test in `test/compatibility/surface.test.ts` also asserts that the
committed baseline matches the tree, so a stale baseline fails the normal test
suite as well.

## Adding a compatible surface

A new command, tool, config key, hook, endpoint, or script is additive. Run:

```sh
bun run compatibility:audit --update
```

No waiver is needed. Commit the updated `baseline.json` together with the
feature.

## Making a breaking change

1. Add an entry to `waivers.json`.
2. Add or update a test that references the changed path. The audit checks that
   every listed file exists and that at least one of them contains the `path`
   string.
3. Run `bun run compatibility:audit --update`. It refuses to update the baseline
   while a breaking change has no valid waiver. `--force` exists as an
   emergency escape hatch and should not be used in normal changes.
4. Keep the waiver as a historical record. After the baseline update it no
   longer matches a current change, so the report lists it as historical.

Waiver format:

```json
{
  "surface": "cli.commands",
  "path": "old-command",
  "reason": "the command was replaced by `providers` in the same release",
  "migration": "automatic: `old-command` is rewritten to `providers` with a warning",
  "tests": ["packages/opencode/test/cli/providers-migration.test.ts"]
}
```

Rules enforced by the audit:

- `surface` must be one of the surfaces in `packages/opencode/src/compatibility/audit.ts`.
- `path` must be the exact baseline path (command name, config key, tool id,
  endpoint string, keybind action, script name, ...).
- `reason` and `migration` must be non-empty.
- `tests` must be non-empty, every file must exist, and at least one must
  contain the `path` string.
- Duplicate `surface` + `path` entries are rejected.
- A valid waiver with no matching current change is historical and does not
  fail the audit.

## Migration expectations

Prefer deprecation over removal. Keep aliases for renamed commands and config
keys for at least one release. When an automatic migration is feasible, implement
it and test the old-to-new mapping; otherwise document the manual steps in
`migration`. A breaking change without a migration story should not be accepted.

## Extraction notes

- Config, agent, MCP, and plugin version data come from the runtime schemas.
- CLI commands, tool ids, plugin hooks, and TUI config keys are read from the
  modules that define them. Nested commands and flags are keyed by their
  defining file (for example `mcp.ts::list`) to keep duplicate names such as
  `list` distinct. Moving a command to another module is therefore a contract
  change: run `--update` and treat the removed entries as breaking changes.
  Tool ids that reference a constant are resolved from the same file or from
  exported constants; an unresolvable id fails the extraction instead of
  silently disappearing.
- TUI config keys are parsed from the `Info` schema source because importing that
  module would pull the Solid/JSX runtime into a plain script.
- The HTTP API surface is read from `OpenCodeHttpApi.groups` so paths and methods
  are the real ones.
- `cmd/run/` is excluded from the CLI scan because it contains the interactive
  run UI and demo fixtures, not command definitions.
