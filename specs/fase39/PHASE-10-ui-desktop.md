# FASE 39 — PHASE 10: UI/UX + desktop

Date: 2026-10-25.
Scope: validate the UI/desktop packages (`packages/app`, `packages/web`, `packages/desktop`)
on this Windows host: typecheck and production builds, plus the compile-time fixes required
to get there.

## Status: Validated (typecheck + production builds)

FEATURE: PHASE 10 UI/UX + desktop validation
STATUS: validated for typecheck and production compilation on this host
LIMITATION: no runtime Electron launch and no broad UI test sweep (see Remaining / FASE 40)
TECHNICAL REASON: this checkout has no Electron binary (`packages/desktop/node_modules/electron/dist`
missing), the host has 6 GB RAM / 2 cores, and the branch already carries unrelated failing
i18n parity tests (details below)
WHAT WAS IMPLEMENTED: no UI redesign; three focused fixes that unblock the typecheck/build gate
WHAT REMAINS: run the app UI suite green (blocked by pre-existing i18n parity drift), launch
Electron on a machine with the Electron binary, and validate the desktop packaging step

## What was fixed to unblock validation

1. `packages/app/src/custom-elements.d.ts` was tracked as a symlink (git mode `120000`) pointing
   at `../../ui/src/custom-elements.d.ts`. On Windows with `core.symlinks=false` the checkout
   stored the link target as plain text, so `tsgo -b` failed with `TS1128: Declaration or
   statement expected`.
   Fix: replaced the symlink with a regular file (mode `100644`) containing
   `/// <reference path="../../ui/src/custom-elements.d.ts" />`. The declaration stays owned by
   `packages/ui`; the app only references it. This works on Windows, Linux, and macOS
   (FASE 41 #7) without duplicating the declaration.
2. `packages/app/src/context/language.tsx` was missing `"dashboard.agents.pending"` in the
   `PluralKey` union, so the three `language.plural("dashboard.agents.pending", ...)` call sites
   in `dialog-dashboard-v2.tsx` did not typecheck. This was a pre-existing branch error that
   became visible once the `TS1128` parse failure was removed. Fix: added the key to the union.
3. Root `package.json` had a trailing comma in the `catalog` block (introduced with the
   playwright catalog entry). Bun tolerates it, but Vite/esbuild parse `package.json` as strict
   JSON, so `vite build` in `packages/app` failed with `JSON does not support trailing commas`
   while loading `vite.config.ts`. Fix: removed the trailing comma and restored the catalog
   indentation.

No public API, architecture, or user-visible copy was changed. No dependency was added.

## Validation

| Package | Command | Result |
|---|---|---|
| `packages/app` | `bun run typecheck` (`tsgo -b`) | pass |
| `packages/app` | `bun run build` (`vite build`) | pass, `dist/` emitted, 12m36s |
| `packages/app` | `bun test --conditions=solid --preload ./happydom.ts ./src/addons/serialize.test.ts ./src/desktop-menu.test.ts ./src/components/file-tree.test.ts ./src/components/status-popover-indicator.test.ts` | 27/27 pass |
| `packages/desktop` | `bun run typecheck` (`tsgo -b`) | pass |
| `packages/desktop` | `electron-vite build` (main/preload/renderer) | pass, `out/` emitted, 4m25s |
| `packages/web` | `bun run build` (`astro build`) | pass, `dist/` emitted, server build 1380s |

Notes:

- Desktop's package `build` script runs `prebuild` first. `copy-icons`, `copy-metainfo`, and
  `bun script/build-node.ts` completed; the dev-only `downloadCliToResources()` step then ran
  `bun add @opencode-ai/cli-windows-x64-baseline@0.0.0-next-16350` and stalled on this network
  (VPN/proxy environment). The Electron compilation was therefore validated directly with
  `electron-vite build` after those prebuild steps.
- Node's default heap (~2 GB) is not enough for the desktop bundle on this host: the first
  direct attempt died with `Reached heap limit`. The successful run used
  `NODE_OPTIONS=--max-old-space-size=4096`; the web build used `--max-old-space-size=3072`.
  These are host memory limits (6 GB RAM, 2 logical CPUs), not source problems.

## Remaining limitations (FASE 40)

- **Runtime Electron launch not validated.** `packages/desktop/node_modules/electron/dist` is
  absent in this checkout (no `electron.exe`), so only compilation was verified.
- **Windows symlink checkout for public assets.** `packages/app/public/*` favicons,
  `site.webmanifest`, and social images are tracked as symlinks into
  `packages/ui/src/assets`. With `core.symlinks=false`, the Windows checkout contains the link
  targets as text, and the Vite build copies those text stubs into `dist/` (39–56 byte files).
  The build gate passes, but a local Windows `dist/` has broken icons. Fix options: enable git
  symlinks (Developer Mode) and re-checkout, or generate/copy the assets at build time. This is
  a checkout/environment issue, not a source regression.
- **Pre-existing i18n parity failures.** `packages/app/src/i18n/parity.test.ts` fails on this
  branch because `en.ts` contains keys that no non-English locale has yet
  (`browser.*`, `command.inline.*`, `command.dashboard.open`, `dashboard.*`,
  `desktop.menu.inline*`) and the `dashboard.agents.pending` plural family is English-only.
  The parity test also throws while comparing placeholders because the target `.other` variant
  is missing. PHASE 10 did not add these keys; fabricating translations is out of scope and
  contradicts the app localization rules, so the full `test:unit` suite is not green.
- **No UI/UX redesign.** PHASE 10 in this arc is a validation phase; no new screens or
  interaction changes were requested or invented.
