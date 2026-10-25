# FASE 39 — PHASE 8: Security + OS sandbox

Date: 2026-10-25.

## Status: Partial by platform constraint (FASE 40)

FEATURE: PHASE 8 OS sandbox
STATUS: documented limitation (no real OS jail implemented)
LIMITATION: cannot produce a real OS-level sandbox from this TS/Bun codebase alone
TECHNICAL REASON: a genuine sandbox (`seccomp-bpf` on Linux, `Job Objects`/`AppContainer` on Windows, `sandbox-exec`/` Seatbelt` on macOS) requires native syscalls or platform-specific native bindings. No such bindings, package, or dependency exists in the repository today, and FASE 41 forbids inventing one. Re-implementing a JavaScript-level firewall against system calls or path joins would be a fake "sandbox" and is explicitly avoided by FASE 40.
WHAT WAS IMPLEMENTED: existing, honest security surfaces, validated:
- `SecurityScanner` (`packages/opencode/src/security/scanner.ts`) over project files with deterministic regex rules, per-finding severity/category/remediation, and 25/25 tests in `packages/opencode/test/security/scanner.test.ts`.
- Permission policy and permission prompts on destructive tools (` packages/opencode/src/permission/*`, `case "ask"` in tool flow).
- MCP local-server `sandbox: true` marking of local MCP processes.
- Static security scan wrapped as the agent-facing `security` tool (`packages/opencode/src/tool/security.ts`).
WHAT REMAINS: an OS jail requires an explicit dependency/platform decision and native bindings. Candidate follow-ups:
- Linux: wrap child exec in `bwrap` (bubblewrap) or `firejail` via existing cross-spawn spawner, gated behind the same permission check.
- macOS: `sandbox-exec` profile files generated per tool call.
- Windows: launch with `CREATE_SUSPENDED` + a Job Object in a native helper, or container-based execution.
- A first-class `Sandbox` service with `runInSandbox(cmd)` consumed by `ShellTool` once those mechanisms are wired per OS.
VALIDATION:
- `bun test test/security/scanner.test.ts` → 25/25 pass.
- `bun typecheck` (packages/opencode) → only known untracked slide WIP errors.
