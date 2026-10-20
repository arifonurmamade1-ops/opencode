# Startup performance

FASE 33 keeps the CLI startup path proportional to the work being done. This
directory documents the startup audit; the existing benchmark suite in
`packages/opencode/src/benchmark` remains the source for functional latency,
rendering, streaming, and scheduling measurements.

## Commands

```bash
# Version probe (default: three samples after one warmup)
bun run performance:audit

# Include top-level --help (expensive: it loads the whole command tree)
bun run performance:audit --full --runs 1

# Regression gate used by CI: version median must stay under 15s
bun run performance:audit --check

# Machine-readable output
bun run performance:audit --json

# Functional latency, rendering, streaming, and scheduling cases
bun run --cwd packages/opencode bench:test
```

The audit spawns `src/index.ts` in a fresh Bun process from the repository
root. It deliberately does not run from `packages/opencode`, so the dev-only
`@opentui/solid/preload` from that package's `bunfig.toml` is not counted as
CLI bootstrap. One warmup run is discarded before samples are recorded.

For each sample it reports wall time, process CPU time, and peak RSS. Peak RSS
is normalized from Bun's `maxRSS` units (KiB on Linux/Windows, bytes on macOS).
`--check` only gates the version probe because top-level help still loads the
complete command tree and is environment-sensitive.

## Baseline

Measured on Windows x64 with Bun 1.3.14:

| Path                        |          Before FASE 33 |         After FASE 33 |
| --------------------------- | ----------------------: | --------------------: |
| `opencode --version` (warm) |                   48.3s |              0.2–0.7s |
| Static CLI command graph    |   157 modules / 1.10 MB | 139 modules / 0.99 MB |
| `opencode --help`           | not separately recorded |                 38.6s |

The version number is now printed by the `src/index.ts` bootstrap before yargs
or any command module is imported. The remaining `--help` cost comes from the
static command tree in `src/cli/main.ts`; reducing it further requires the same
lazy treatment for the remaining heavy commands (`import`, `providers`,
`stats`, `export`, `session`, `mcp`). The debug subcommands are already lazy.

Graph sizes count source modules under the repository (including workspace
packages) reached by static imports, with type-only imports excluded; they do
not include `node_modules`. They are supporting context for the runtime
numbers, not a CI gate.

## Implementation notes

- `src/index.ts` is only a bootstrap. It recognizes `--version` / `-v` before
  importing the full CLI, ignores flags after a `--` separator, and lets
  `--help` take precedence when both are present.
- `src/cli/main.ts` owns the yargs instance, middleware, global options, and
  the full command list.
- `lazyCmd` in `src/cli/cmd/cmd.ts` models the async builders yargs already
  supports. `debug` uses it to import its subcommands only when yargs parses
  or renders the debug command.
- The compatibility extractor reads the command tree from
  `src/cli/main.ts`, so moving the entrypoint did not change the contract.

## Guardrails

- Do not add runtime imports to `src/index.ts`; they are paid by every
  `--version` probe.
- New top-level commands belong in `src/cli/main.ts`. If a command owns heavy
  subcommands, define its builder with `lazyCmd` and keep the command name,
  aliases, description, and options synchronous for help snapshots.
- Keep the version gate generous enough for slow CI runners. It catches a
  return to the full command graph, not normal machine-to-machine variance.
