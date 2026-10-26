# FASE 39 — PHASE 5: Artifacts + verification

Date: 2026-10-24 (post PHASE 6, commit `23c8b11`).
Scope: provide a general artifact store and verification runner instead of ad-hoc path joins in the autonomous tool, while keeping artifacts as individual Markdown files on disk (no general artifact datastore, per existing limitations).

## What was implemented

- New service: `packages/opencode/src/artifact.ts` (`Artifact.Service`, `@opencode/Artifact`).
  - `dir()` — artifact directory for the current instance (`.opencode/artifacts`).
  - `list()` — Markdown artifacts with `{ id, path, size, updatedAt }`, sorted newest first.
  - `read(id)` — content or undefined.
  - `write(id, content)` — writes (creating dirs) and returns the path.
  - `verify({ id, acceptance })` — structured verification: file exists, non-empty, and every acceptance criterion appears (case-insensitive) as evidence in the content. Returns `{ ok, problems }`.
  - Artifact ids are single path segments: separators (`/`, `\`), NUL, `:`, `.` and `..` are rejected so an id cannot escape the artifact directory. Invalid ids fail `write`, return undefined from `read`, and produce a structured problem from `verify`.
- Layer: `Artifact.node` depends on `FSUtil.node` (real filesystem, consistent with the autonomous tool); registry is implicit in the directory listing (no separate index).

## Tests

- `packages/opencode/test/artifact.test.ts` — 6/6 pass:
  - write + read + dir
  - list with metadata (size, updatedAt)
  - missing artifact → undefined
  - verify (all criteria met; missing criterion; missing file)
  - empty artifact flagged
  - ids with traversal/separator/ADS attempts are rejected and no file is written outside the artifact directory

## Limitations (FASE 40)

- Artifacts remain individual Markdown files; this is an index over them, not a general artifact browser/dashboard.
- Verification is content/evidence based (substring match against acceptance criteria), not a semantic check of the delivered work. Deeper verification (running tests, typecheck) stays with the caller.
- Does not replace the autonomous tool's own `.opencode/autonomous/<id>.md` writes; those remain owned by `tool/autonomous.ts`. A future unification could point the autonomous tool at this service.

## Validation

- `bun test test/artifact.test.ts` → 6/6 pass.
- `bun typecheck` (packages/opencode) → only the known untracked slide WIP errors.

## Next action

PHASE 3 (multi-agent orchestration) — fan-out/fan-in and cancellation propagation across agents, building on the Agent Manager. Awaiting explicit go.
