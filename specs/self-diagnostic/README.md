# Self-diagnostics

FASE 36 adds two entry points for the same diagnosis:

- `opencode doctor` reports on the machine that runs the CLI.
- `/doctor` inside the TUI reports on the server the TUI is attached to.

Both are actionable: every non-OK check names what failed and what to do next.
The CLI report never includes API keys, authorization headers, or MCP secrets.

## CLI

```sh
opencode doctor
opencode doctor --json
opencode doctor --network
```

The command runs without loading a project instance, so it can diagnose a broken
configuration that would otherwise stop OpenCode at startup. It exits `1` when a
check fails and `0` when checks are only warnings or skipped.

`--json` emits a stable shape for CI and scripts:

```json
{
  "version": "1.2.3",
  "directory": "/path/to/project",
  "checks": [
    {
      "id": "config",
      "title": "Configuration",
      "status": "ok",
      "summary": "2 configuration files loaded.",
      "details": ["/home/me/.config/opencode/opencode.json: valid"]
    }
  ],
  "summary": { "ok": 8, "warn": 2, "fail": 0, "skip": 2 }
}
```

`--network` opts into probing configured provider endpoints. The probe sends no
credentials, accepts any HTTP response as reachability, and uses a five-second
timeout. It never runs by default because the machine may be offline, behind a
VPN, or metered.

## Checks

| Check          | What it verifies                                                                 |
| -------------- | -------------------------------------------------------------------------------- |
| Configuration  | Global, project, `.opencode`, `OPENCODE_CONFIG`, and `OPENCODE_CONFIG_CONTENT` files parse and validate. Compatibility warnings are surfaced. |
| Providers      | Enabled/disabled providers, authentication files, API keys in config, and provider environment variables. Explicitly configured providers without detected credentials warn instead of failing, because local servers may not require a key. |
| Models         | `model` and `small_model` resolve to a provider/model in the catalog or custom config. |
| APIs           | Configured endpoint URLs are valid HTTP(S); environment-variable templates are reported but not evaluated; `--network` optionally probes reachability. |
| MCP            | Local commands exist, remote URLs are valid, disabled servers are counted, and MCP sandbox flags are reported. |
| Browser        | Explicitly reports that no browser-automation runtime is available.               |
| LSP            | Built-in LSP status and custom server commands.                                     |
| Git            | Git binary, version, repository root, branch, and working-tree change count.      |
| Permissions    | Explicit permission rules; warns about broad `allow` rules for edits, bash, or external paths. |
| Sandbox        | Reports MCP local-server sandboxing and that no general sandbox runtime exists.    |
| Storage        | Data directory write probe, state/cache paths, and database path/size.            |
| Dependencies   | OpenCode version/channel, Bun, Node, Git, and ripgrep availability.                |

Live MCP connections, LSP clients, providers, and the current model are already
loaded by the TUI, so `/doctor` reads them from the active session snapshot. The
CLI stays static and safe: it does not open a project instance, start MCP
servers, start LSP servers, or apply database migrations.

## Honest limitations

- Browser automation is not implemented in this runtime. The doctor says so
  rather than pretending to check a browser that does not exist.
- There is no general-purpose sandbox. Only local MCP servers support
  `sandbox: true`; worktrees isolate changes but are not a security boundary.
- The CLI does not print remote/well-known configuration merged by the server.
  The TUI `/doctor` reflects the server's loaded configuration.
- API probing tests reachability, not authentication or model access.
- Storage checks do not calculate free disk space.
- Configured URLs are displayed with userinfo and query strings redacted so tokens
  embedded in a URL do not end up in logs or pasted reports.

## Tests

- `packages/opencode/test/cli/doctor.test.ts` exercises a healthy report and an
  invalid `OPENCODE_CONFIG_CONTENT` failure.
- `packages/tui/test/doctor.test.ts` covers the TUI report builder, including
  provider/model/MCP/LSP failures and broad permission warnings.
