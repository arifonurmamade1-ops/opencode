# FASE 39 — PHASE 10: UI/UX + desktop

Date: 2026-10-25.
Scope: validate the UI/desktop packages typecheck and build on this host.

## Status: Not validated on this host (FASE 40)

FEATURE: PHASE 10 UI/UX + desktop validation
STATUS: not validated
LIMITATION: cannot typecheck `packages/app` on this Windows host
TECHNICAL REASON: `packages/app/src/custom-elements.d.ts` is committed as a regular file
  whose contents are the relative path string `../../ui/src/custom-elements.d.ts`. On
  Unix this is a symlink to the ui package's declaration file; the Windows checkout
  stores it as a text file (git mode 100644, `LinkType` empty). `tsgo -b` then
  fails with `TS1128: Declaration or statement expected` on line 1 of that file,
  because a declaration file containing a bare path string is not valid TypeScript.
  Confirmed this file is tracked and untouched by this arc
  (`git ls-files packages/app/src/custom-elements.d.ts` → present, mode 100644,
  `git status --short` → clean before this work). The opencode/core changes in this
  arc do not touch app/ui/desktop, so this is a pre-existing host/build-environment
  limitation, not a regression introduced here.
WHAT WAS IMPLEMENTED: nothing code-wise. No UI/UX or desktop feature changes were
  made in this arc; the packages are untouched.
WHAT REMAINS: validate `bun run typecheck`/`bun run build` for `packages/app`,
  `packages/web`, and `packages/desktop` on a host where git symlinks resolve
  (Linux/macOS or Windows with symlink privileges and `core.symlinks=true`),
  or replace the symlink-as-text placeholder with a real project reference in
  `tsconfig.json` / a small `.d.ts` shim if the team wants Windows-local
  typechecking. Desktop/web build validation was not attempted to avoid churn on
  a slow host given the blocked typecheck gate.

## Environment note

- `packages/app`: typecheck script `tsgo -b` fails as above; build script `vite build`
  (not separately attempted).
- `packages/web`: build script `astro build`; no typecheck script.
- `packages/desktop`: typecheck `tsgo -b`; build `electron-vite build` (not attempted).
