# FASE 39 — PHASE 4: Browser Agent

Date: 2026-10-25 (explicit dependency decision: Playwright approved by the user).

## What was implemented

- New service `Browser.Service` (`packages/opencode/src/browser.ts`, `@opencode/Browser`).
  - Manages a Playwright Chromium headless instance scoped per instance directory (lazy launch, close on disposal).
  - Surface: `newPage(id?, url?)`, `navigate`, `click`, `fill`, `text`, `title`, `evaluate`, `screenshot`, `pages`, `closePage`, `closeAll`.
- Agent-facing tool `browser` (`packages/opencode/src/tool/browser.ts`) exposing a single `action` enum covering all operations; registered in `tool/registry.ts` and gated behind the normal tool registry (no host startup cost — the browser only launches on first use).
- `browser-worker.cjs` runs Playwright in a child Node process (rather than in the Bun runtime, where `chromium.launch()` wedges) and exposes its API over a localhost HTTP server on an ephemeral port. The Bun-side service speaks HTTP to it and tears it down via `Effect.addFinalizer`.
- Dependency: added `playwright-core@1.59.1` to the workspace catalog and to `packages/opencode` dependencies.

## Tests

- `packages/opencode/test/browser.test.ts` — 3/3 pass (66s).
  - new page + `evaluate`/`title`/`text`
  - `fill` + `click` on rendered HTML
  - screenshot to disk
- `bun typecheck` (packages/opencode) → only the known untracked slide WIP errors.

## Limitations / FASE 40

- One browser instance per instance directory; pages are identified by string ids supplied by the caller (`"main"` default).
- The worker is a `.cjs` file on disk beside the compiled bundle. When packaging/bundling changes, its placement must stay resolvable via `import.meta.url`.
- Launching depends on a locally available browser. The worker resolves the Chrome executable from `%LOCALAPPDATA%/ms-playwright/chromium*/chrome-win64/chrome.exe` when env `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is unset. On hosts without a compatible browser, the service returns a typed `BrowserError`.
- Only `chromium` is wired. Firefox / WebKit reuse would be a small, additive change.

## Validation

- `bun test test/browser.test.ts` → 3/3 pass.
- `bun typecheck` → only the known untracked slide WIP errors.
