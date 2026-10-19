/**
 * Deterministic benchmark cases — FASE 30.
 *
 * Every case exercises real OpenCode code paths (edit engine, MCP policy,
 * permission evaluation, retry policy, context ranking, truncate, background
 * jobs, fetch tool, agent catalog, provider routing) in the local process.
 * No case calls a model: measurements stay reproducible and free.
 *
 * Cases that cannot run in a non-interactive process (real browser sessions,
 * TUI rendering) are declared with `unavailable` and an explicit reason instead
 * of returning fabricated numbers.
 */

import { BackgroundJob } from "@opencode-ai/core/background-job"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { compressToBudget, estimateTokens, rankByRelevance } from "@opencode-ai/core/system-context/relevance"
import type { NamedError } from "@opencode-ai/core/util/error"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Effect, Exit } from "effect"
import os from "node:os"
import path from "node:path"
import type { Agent } from "@/agent/agent"
import { McpPolicy } from "@/mcp/policy"
import { evaluate } from "@/permission/evaluate"
import type { Provider } from "@/provider/provider"
import { SessionRetry } from "@/session/retry"
import { MessageID, SessionID } from "@/session/schema"
import { replace } from "@/tool/edit"
import type { Tool } from "@/tool/tool"
import type { Truncate } from "@/tool/truncate"
import type { WebFetchTool } from "@/tool/webfetch"
import type { CaseInfo, CaseResult, Direction } from "./report"

export type FetchTool = Tool.InferDef<Awaited<typeof WebFetchTool>>

export interface CaseDeps {
  readonly fs: FSUtil.Interface
  readonly truncate: Truncate.Interface
  readonly agents: Agent.Interface
  readonly providers: Provider.Interface
  readonly webfetch: FetchTool
}

export interface CaseDefinition extends CaseInfo {
  readonly run: (deps: CaseDeps) => Effect.Effect<CaseResult, Error>
}

const higher = (value: number) => ({ value, direction: "higher" as const })
const lower = (value: number) => ({ value, direction: "lower" as const })
const informational = (value: number) => ({ value, direction: "info" as const })

const unavailable = (detail: string): Effect.Effect<CaseResult> => Effect.succeed({ status: "unavailable", detail })

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Scoped fixture directory outside the project (never mutates the workspace). */
const tempDir = (fs: FSUtil.Interface) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const dir = path.join(
        os.tmpdir(),
        `opencode-benchmark-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      )
      yield* fs.ensureDir(dir)
      return dir
    }),
    (dir) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore),
  )

function tryReplace(content: string, oldString: string, newString: string): Effect.Effect<string, string> {
  return Effect.try({
    try: () => replace(content, oldString, newString),
    catch: (error) => messageOf(error),
  })
}

const CODING_SOURCE = [
  "export type Item = { price: number; quantity: number }",
  "",
  "export function total(items: Item[]) {",
  "  return items.reduce((sum, item) => sum + item.price, 0)",
  "}",
  "",
  "export function label(item: Item) {",
  "  if (item.price === 0) {",
  '    return "free"',
  "  }",
  '  return "price: " + item.price',
  "}",
  "",
].join("\n")

const CODING_EDITS = [
  {
    name: "exact",
    old: "return items.reduce((sum, item) => sum + item.price, 0)",
    new: "return items.reduce((sum, item) => sum + item.price * item.quantity, 0)",
  },
  {
    name: "indentation",
    old: ["      if (item.price === 0) {", '        return "free"', "      }"].join("\n"),
    new: ["  if (item.quantity === 0) {", '    return "empty"', "  }"].join("\n"),
  },
  {
    name: "whitespace",
    old: 'return  "price: "  +  item.price',
    new: '  return "price: " + item.price + " x" + item.quantity',
  },
]

const CODING_EXPECTED = [
  "export type Item = { price: number; quantity: number }",
  "",
  "export function total(items: Item[]) {",
  "  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)",
  "}",
  "",
  "export function label(item: Item) {",
  "  if (item.quantity === 0) {",
  '    return "empty"',
  "  }",
  '  return "price: " + item.price + " x" + item.quantity',
  "}",
  "",
].join("\n")

const CODING_CASE: CaseDefinition = {
  id: "coding.apply-edit",
  category: "coding",
  title: "Apply scripted edits through the real edit engine",
  description:
    "Applies three edits (exact, indentation-shifted, whitespace-normalized) with the same replace() chain the edit tool uses.",
  metrics: { edits: "higher", applied: "higher", correct: "higher", duration_ms: "lower" },
  run: (deps) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir(deps.fs)
        const file = path.join(dir, "items.ts")
        yield* deps.fs.writeWithDirs(file, CODING_SOURCE)

        const start = yield* Clock.currentTimeMillis
        let content = CODING_SOURCE
        let applied = 0
        const errors: string[] = []
        for (const edit of CODING_EDITS) {
          const outcome = yield* tryReplace(content, edit.old, edit.new).pipe(Effect.exit)
          if (Exit.isSuccess(outcome)) {
            content = outcome.value
            applied += 1
          } else {
            errors.push(`${edit.name}: ${messageOf(Cause.squash(outcome.cause))}`)
          }
        }
        yield* deps.fs.writeWithDirs(file, content)
        const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)

        const onDisk = yield* deps.fs.readFileStringSafe(file)
        const correct = onDisk === CODING_EXPECTED && applied === CODING_EDITS.length
        return {
          status: correct ? "pass" : "fail",
          metrics: {
            edits: higher(CODING_EDITS.length),
            applied: higher(applied),
            correct: higher(correct ? 1 : 0),
            duration_ms: lower(durationMs),
          },
          ...(correct
            ? {}
            : { detail: errors.length > 0 ? errors.join("; ") : "final content does not match the expected result" }),
        }
      }),
    ),
}

const DEBUG_FILES: Record<string, string> = {
  "src/pricing/format.ts": "export function formatPrice(value: number) { return value.toFixed(2) }\n",
  "src/pricing/labels.ts": 'export function priceLabel(value: number) { return value === 0 ? "free" : "paid" }\n',
  "src/pricing/bulk.ts": "export function bulk(items: unknown[]) { return items.length > 10 }\n",
  "src/pricing/tax.ts": "export function tax(value: number, rate: number) { return value * rate }\n",
  "src/pricing/round.ts": "export function round(value: number) { return Math.round(value * 100) / 100 }\n",
  "src/pricing/total.ts": [
    "export function totalPrice(items: { price: number }[]) {",
    "  return items.reduce((sum, item) => sum - item.price, 0)",
    "}",
    "",
  ].join("\n"),
}

const DEBUG_QUERY = "sum price reduce total"
const DEBUG_BUG = "sum - item.price"
const DEBUG_FIX = "sum + item.price"
const DEBUG_TARGET = "src/pricing/total.ts"

const DEBUGGING_CASE: CaseDefinition = {
  id: "debugging.locate-fix",
  category: "debugging",
  title: "Locate a planted defect by relevance and fix it",
  description: `Ranks ${Object.keys(DEBUG_FILES).length} fixture files by query relevance, then repairs the detected defect in ${DEBUG_TARGET} with the edit engine.`,
  metrics: { candidates: "info", located_top: "higher", fixed: "higher", duration_ms: "lower" },
  run: (deps) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir(deps.fs)
        const names = Object.keys(DEBUG_FILES)
        for (const name of names) {
          yield* deps.fs.writeWithDirs(path.join(dir, name), DEBUG_FILES[name]!)
        }

        const start = yield* Clock.currentTimeMillis
        const docs = yield* Effect.all(
          names.map((name) =>
            Effect.gen(function* () {
              const text = (yield* deps.fs.readFileStringSafe(path.join(dir, name))) ?? ""
              return { name, text }
            }),
          ),
        )
        const ranked = rankByRelevance(DEBUG_QUERY, docs, (doc) => doc.text)
        const top = ranked[0]
        const located = top?.source.name === DEBUG_TARGET && (top?.score ?? 0) > (ranked[1]?.score ?? 0)

        let fixed = false
        if (located) {
          const file = path.join(dir, DEBUG_TARGET)
          const original = (yield* deps.fs.readFileStringSafe(file)) ?? ""
          const outcome = yield* tryReplace(original, DEBUG_BUG, DEBUG_FIX).pipe(Effect.exit)
          if (Exit.isSuccess(outcome)) {
            yield* deps.fs.writeWithDirs(file, outcome.value)
            const back = (yield* deps.fs.readFileStringSafe(file)) ?? ""
            fixed = !back.includes(DEBUG_BUG) && back.includes(DEBUG_FIX)
          }
        }

        const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
        return {
          status: located && fixed ? "pass" : "fail",
          metrics: {
            candidates: informational(names.length),
            located_top: higher(located ? 1 : 0),
            fixed: higher(fixed ? 1 : 0),
            duration_ms: lower(durationMs),
          },
          ...(located && fixed
            ? {}
            : { detail: located ? "fix was not applied cleanly" : `top candidate was ${top?.source.name ?? "none"}` }),
        }
      }),
    ),
}

const RENAME_FILES: Record<string, string> = {
  "src/total.ts": [
    "export function computeTotal(items: number[]) {",
    "  return items.reduce((sum, value) => sum + value, 0)",
    "}",
    "",
  ].join("\n"),
  "src/report.ts": [
    'import { computeTotal } from "./total"',
    "",
    "export function report(items: number[]) {",
    "  return `total: ${computeTotal(items)}`",
    "}",
    "",
  ].join("\n"),
  "src/invoice.ts": [
    'import { computeTotal } from "./total"',
    "",
    "export function invoice(items: number[]) {",
    "  const total = computeTotal(items)",
    "  return computeTotal(items) + total",
    "}",
    "",
  ].join("\n"),
  "src/decoy.ts": ["export function computeTotals(items: number[]) {", "  return items.length", "}", ""].join("\n"),
}

const RENAME_EDITS: ReadonlyArray<{ file: string; old: string; new: string }> = [
  { file: "src/total.ts", old: "export function computeTotal", new: "export function sumTotal" },
  { file: "src/report.ts", old: 'import { computeTotal } from "./total"', new: 'import { sumTotal } from "./total"' },
  { file: "src/report.ts", old: "${computeTotal(items)}", new: "${sumTotal(items)}" },
  { file: "src/invoice.ts", old: 'import { computeTotal } from "./total"', new: 'import { sumTotal } from "./total"' },
  { file: "src/invoice.ts", old: "const total = computeTotal(items)", new: "const total = sumTotal(items)" },
  { file: "src/invoice.ts", old: "return computeTotal(items) + total", new: "return sumTotal(items) + total" },
]

const RENAME_EXPECTED_REFS = 6

const REFACTORING_CASE: CaseDefinition = {
  id: "refactoring.rename-symbol",
  category: "refactoring",
  title: "Rename a symbol across files without collateral damage",
  description:
    "Renames computeTotal to sumTotal across four fixture files through the edit engine and verifies no stale references and that the similar name computeTotals is untouched.",
  metrics: {
    files: "info",
    edits: "higher",
    applied: "higher",
    renamed_refs: "higher",
    stale_refs: "lower",
    decoy_preserved: "higher",
    correct: "higher",
    duration_ms: "lower",
  },
  run: (deps) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir(deps.fs)
        const names = Object.keys(RENAME_FILES)
        for (const name of names) {
          yield* deps.fs.writeWithDirs(path.join(dir, name), RENAME_FILES[name]!)
        }

        const start = yield* Clock.currentTimeMillis
        const contents = new Map<string, string>(names.map((name) => [name, RENAME_FILES[name]!]))
        let applied = 0
        const errors: string[] = []
        for (const edit of RENAME_EDITS) {
          const current = contents.get(edit.file)!
          const outcome = yield* tryReplace(current, edit.old, edit.new).pipe(Effect.exit)
          if (Exit.isSuccess(outcome)) {
            contents.set(edit.file, outcome.value)
            applied += 1
          } else {
            errors.push(`${edit.file}: ${messageOf(Cause.squash(outcome.cause))}`)
          }
        }
        for (const name of names) {
          yield* deps.fs.writeWithDirs(path.join(dir, name), contents.get(name)!)
        }

        const final = yield* Effect.all(
          names.map((name) =>
            Effect.gen(function* () {
              return (yield* deps.fs.readFileStringSafe(path.join(dir, name))) ?? ""
            }),
          ),
        )
        const stale = final.filter((text) => /\bcomputeTotal\b/.test(text)).length
        const renamed = final.reduce((sum, text) => sum + (text.match(/\bsumTotal\b/g)?.length ?? 0), 0)
        const decoy = final[names.indexOf("src/decoy.ts")] ?? ""
        const decoyPreserved = decoy.includes("computeTotals") && !decoy.includes("sumTotal")
        const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)

        const correct =
          applied === RENAME_EDITS.length && stale === 0 && renamed === RENAME_EXPECTED_REFS && decoyPreserved
        return {
          status: correct ? "pass" : "fail",
          metrics: {
            files: informational(names.length),
            edits: higher(RENAME_EDITS.length),
            applied: higher(applied),
            renamed_refs: higher(renamed),
            stale_refs: lower(stale),
            decoy_preserved: higher(decoyPreserved ? 1 : 0),
            correct: higher(correct ? 1 : 0),
            duration_ms: lower(durationMs),
          },
          ...(correct ? {} : { detail: errors.length > 0 ? errors.join("; ") : "verification failed" }),
        }
      }),
    ),
}

const BROWSER_HTML = [
  "<!doctype html>",
  "<html>",
  "  <head><title>Benchmark Fixture</title></head>",
  "  <body>",
  "    <h1>Local fixture</h1>",
  "    <p>Extraction check: <strong>42</strong></p>",
  "    <pre><code>const answer = 42</code></pre>",
  "  </body>",
  "</html>",
  "",
].join("\n")

const BROWSER_CASE: CaseDefinition = {
  id: "browser.fetch-extract",
  category: "browser",
  title: "Fetch a local page and extract markdown",
  description:
    "Serves a fixture page on localhost and runs the real fetch tool end-to-end (decoding, HTTP, HTML to markdown, truncation wrapper).",
  metrics: { status_ok: "higher", extract_ok: "higher", chars: "higher", duration_ms: "lower" },
  run: (deps) =>
    Effect.scoped(
      Effect.gen(function* () {
        const agents = yield* deps.agents.list()
        const agent = agents.find((item) => item.name === "build") ?? agents[0]
        if (!agent) return yield* unavailable("no agents are registered, so the fetch tool cannot execute")

        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: () => new Response(BROWSER_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
            }),
          ),
          (value) => Effect.sync(() => value.stop(true)),
        )

        const ctx: Tool.Context = {
          sessionID: SessionID.make("ses_benchmark"),
          messageID: MessageID.make("msg_benchmark"),
          callID: "",
          agent: agent.name,
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }

        const start = yield* Clock.currentTimeMillis
        const outcome = yield* deps.webfetch
          .execute({ url: `http://127.0.0.1:${server.port}/fixture`, format: "markdown" }, ctx)
          .pipe(Effect.exit)
        if (Exit.isFailure(outcome)) {
          return { status: "error", detail: messageOf(Cause.squash(outcome.cause)) }
        }
        const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
        const output = outcome.value.output
        const titleFound = output.includes("Local fixture")
        const codeFound = output.includes("const answer = 42")
        return {
          status: titleFound && codeFound ? "pass" : "fail",
          metrics: {
            status_ok: higher(1),
            extract_ok: higher(titleFound && codeFound ? 1 : 0),
            chars: higher(output.length),
            duration_ms: lower(durationMs),
          },
          ...(titleFound && codeFound
            ? {}
            : { detail: `extracted markdown missing expected content (${output.length} chars)` }),
        }
      }),
    ),
}

const MULTI_AGENT_CASE: CaseDefinition = {
  id: "multi-agent.agent-matrix",
  category: "multi-agent",
  title: "Verify the live agent catalog and permission invariants",
  description:
    "Builds the agent catalog for the current instance and checks the security matrix (plan/explore read-only, build allowed to edit) plus ruleset integrity.",
  metrics: { agents: "info", subagents: "info", checks: "info", checks_ok: "higher", duration_ms: "lower" },
  run: (deps) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const list = yield* deps.agents.list()
      if (list.length === 0) return yield* unavailable("no agents are registered in this instance")

      const checks: Array<{ name: string; ok: boolean }> = []
      for (const agent of list) {
        checks.push({ name: `${agent.name}.ruleset`, ok: Array.isArray(agent.permission) })
      }
      const check = (
        agent: Agent.Info | undefined,
        permission: string,
        pattern: string,
        verdict: (action: string) => boolean,
      ) => {
        if (!agent) return
        const action = evaluate(permission, pattern, agent.permission).action
        checks.push({ name: `${agent.name}.${permission}`, ok: verdict(action) })
      }
      const canEdit = (action: string) => action !== "deny"
      const cannotEdit = (action: string) => action === "deny"
      check(
        list.find((item) => item.name === "build"),
        "edit",
        "src/index.ts",
        canEdit,
      )
      check(
        list.find((item) => item.name === "plan"),
        "edit",
        "src/index.ts",
        cannotEdit,
      )
      check(
        list.find((item) => item.name === "explore"),
        "edit",
        "src/index.ts",
        cannotEdit,
      )
      check(
        list.find((item) => item.name === "explore"),
        "write",
        "src/index.ts",
        cannotEdit,
      )

      const ok = checks.filter((item) => item.ok).length
      const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
      return {
        status: ok === checks.length ? "pass" : "fail",
        metrics: {
          agents: informational(list.length),
          subagents: informational(list.filter((item) => item.mode === "subagent").length),
          checks: informational(checks.length),
          checks_ok: higher(ok),
          duration_ms: lower(durationMs),
        },
        ...(ok === checks.length
          ? {}
          : {
              detail: `failed checks: ${checks
                .filter((item) => !item.ok)
                .map((item) => item.name)
                .join(", ")}`,
            }),
      }
    }),
}

const LONG_RUNNING_JOBS = 3

const LONG_RUNNING_CASE: CaseDefinition = {
  id: "long-running.background-job",
  category: "long-running",
  title: "Run overlapping background jobs to completion",
  description:
    "Starts three overlapping background jobs on the core registry and waits for each to complete, measuring wall-clock latency.",
  metrics: { jobs: "info", completed: "higher", timed_out: "lower", wall_ms: "lower" },
  run: () =>
    Effect.scoped(
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis
        const jobs = yield* BackgroundJob.make
        const started: BackgroundJob.Info[] = []
        for (let index = 0; index < LONG_RUNNING_JOBS; index++) {
          started.push(
            yield* jobs.start({
              type: "benchmark",
              title: `benchmark-job-${index}`,
              run: Effect.sleep(index * 40).pipe(Effect.as("ok")),
            }),
          )
        }
        const waits: BackgroundJob.WaitResult[] = []
        for (const info of started) {
          waits.push(yield* jobs.wait({ id: info.id, timeout: 10_000 }))
        }
        const wallMs = Math.round((yield* Clock.currentTimeMillis) - start)
        const completed = waits.filter((item) => item.info?.status === "completed").length
        const timedOut = waits.filter((item) => item.timedOut).length
        return {
          status: completed === started.length ? "pass" : "fail",
          metrics: {
            jobs: informational(started.length),
            completed: higher(completed),
            timed_out: lower(timedOut),
            wall_ms: lower(wallMs),
          },
          ...(completed === started.length ? {} : { detail: `${timedOut} job(s) timed out` }),
        }
      }),
    ),
}

type Err = ReturnType<NamedError["toObject"]>

const apiError = (data: SessionV1.APIError["data"]): SessionV1.APIError => ({ name: "APIError", data })

const RECOVERY_CLASSIFICATION: ReadonlyArray<{ name: string; error: Err; expected: boolean; reason?: string }> = [
  {
    name: "retryable-5xx",
    error: apiError({ message: "server error", isRetryable: false, statusCode: 503 }),
    expected: true,
  },
  {
    name: "not-retryable-4xx",
    error: apiError({ message: "bad request", isRetryable: false, statusCode: 400 }),
    expected: false,
  },
  { name: "explicit-retryable", error: apiError({ message: "boom", isRetryable: true }), expected: true },
  {
    name: "message-rate-limit",
    error: apiError({ message: "rate limit exceeded", isRetryable: false }),
    expected: true,
  },
  {
    name: "context-overflow",
    error: { name: "ContextOverflowError", data: { message: "prompt is too long" } } as Err,
    expected: false,
  },
  {
    name: "free-tier-limit",
    error: apiError({
      message: "limit",
      isRetryable: true,
      responseBody: '{"error":{"type":"FreeUsageLimitError"}}',
    }),
    expected: true,
    reason: "free_tier_limit",
  },
]

const RECOVERY_DELAYS: ReadonlyArray<{
  attempt: number
  error?: SessionV1.APIError
  random: number
  expected: number
}> = [
  { attempt: 1, random: 0, expected: 2000 },
  { attempt: 2, random: 0.5, expected: 4500 },
  { attempt: 3, random: 1, expected: 10000 },
  {
    attempt: 4,
    error: apiError({ message: "boom", isRetryable: true, responseHeaders: { "retry-after-ms": "1500" } }),
    random: 0,
    expected: 1500,
  },
  { attempt: 5, random: 0, expected: 30000 },
]

const RECOVERY_CASE: CaseDefinition = {
  id: "recovery.retry-policy",
  category: "recovery",
  title: "Classify transient failures and compute retry delays",
  description:
    "Runs the real retry policy over a fixed matrix of provider errors (5xx, 4xx, context overflow, free-tier limit) and validates deterministic exponential delays.",
  metrics: {
    classifications: "info",
    classified_ok: "higher",
    delays: "info",
    delays_ok: "higher",
    duration_ms: "lower",
  },
  run: () =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      let classifiedOk = 0
      const problems: string[] = []
      for (const item of RECOVERY_CLASSIFICATION) {
        const outcome = SessionRetry.retryable(item.error, "benchmark")
        const matched = item.expected ? outcome !== undefined : outcome === undefined
        const reasonOk = item.reason === undefined || outcome?.action?.reason === item.reason
        if (matched && reasonOk) classifiedOk += 1
        else problems.push(item.name)
      }

      let delaysOk = 0
      for (const item of RECOVERY_DELAYS) {
        const actual = SessionRetry.delay(item.attempt, item.error, item.random)
        if (actual === item.expected) delaysOk += 1
        else problems.push(`delay-${item.attempt}: expected ${item.expected}, got ${actual}`)
      }

      const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
      const ok = classifiedOk === RECOVERY_CLASSIFICATION.length && delaysOk === RECOVERY_DELAYS.length
      return {
        status: ok ? "pass" : "fail",
        metrics: {
          classifications: informational(RECOVERY_CLASSIFICATION.length),
          classified_ok: higher(classifiedOk),
          delays: informational(RECOVERY_DELAYS.length),
          delays_ok: higher(delaysOk),
          duration_ms: lower(durationMs),
        },
        ...(ok ? {} : { detail: problems.join("; ") }),
      }
    }),
}

const CONTEXT_QUERY = "validation error handling"
const CONTEXT_DOCS = Array.from({ length: 40 }, (_, index) => {
  if (index === 7) {
    return {
      id: `doc-${index}`,
      text: "validation error handling: report the failing field, the received value and a stable error code for operators.",
    }
  }
  if (index === 11) {
    return { id: `doc-${index}`, text: "error handling notes: retry transient failures and surface a compact summary." }
  }
  if (index === 3) {
    return { id: `doc-${index}`, text: "error taxonomy: group failures by category before reporting them." }
  }
  return { id: `doc-${index}`, text: `routine notes ${index}: formatting and layout guidance without special terms.` }
})

const CONTEXT_BUDGET = 400

const CONTEXT_CASE: CaseDefinition = {
  id: "context.relevance-budget",
  category: "context",
  title: "Rank and compress context to a token budget",
  description: `Ranks ${CONTEXT_DOCS.length} synthetic documents with the real context engine and compresses them to ${CONTEXT_BUDGET} estimated tokens, checking that the most relevant document survives.`,
  metrics: {
    docs: "info",
    top1_ok: "higher",
    kept: "info",
    tokens_in: "info",
    tokens_kept: "lower",
    compression_pct: "higher",
    duration_ms: "lower",
  },
  run: () =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const ranked = rankByRelevance(CONTEXT_QUERY, CONTEXT_DOCS, (doc) => doc.text)
      const kept = compressToBudget(
        ranked.map((item) => item.source),
        CONTEXT_BUDGET,
      )
      const tokensIn = CONTEXT_DOCS.reduce((sum, doc) => sum + estimateTokens(doc.text), 0)
      const tokensKept = kept.reduce((sum, doc) => sum + estimateTokens(doc.text), 0)
      const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
      const top1 = ranked[0]?.source.id === "doc-7"
      const compression = tokensIn > 0 ? 100 * (1 - tokensKept / tokensIn) : 0
      const correct = top1 && kept.length > 0 && tokensKept <= CONTEXT_BUDGET
      return {
        status: correct ? "pass" : "fail",
        metrics: {
          docs: informational(CONTEXT_DOCS.length),
          top1_ok: higher(top1 ? 1 : 0),
          kept: informational(kept.length),
          tokens_in: informational(tokensIn),
          tokens_kept: lower(tokensKept),
          compression_pct: higher(compression),
          duration_ms: lower(durationMs),
        },
        ...(correct ? {} : { detail: `top1=${top1} kept=${kept.length} tokens_kept=${tokensKept}` }),
      }
    }),
}

const denyEdit: PermissionV1.Ruleset = [{ permission: "edit", pattern: "*", action: "deny" }]
const allowEdit: PermissionV1.Ruleset = [{ permission: "edit", pattern: "*", action: "allow" }]
const denySecrets: PermissionV1.Ruleset = [{ permission: "edit", pattern: "src/secrets/*", action: "deny" }]
const denyRm: PermissionV1.Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }]

const PERMISSION_MATRIX: ReadonlyArray<{
  name: string
  permission: string
  pattern: string
  rulesets: ReadonlyArray<PermissionV1.Ruleset>
  expected: string
}> = [
  { name: "no-rules-is-ask", permission: "edit", pattern: "src/index.ts", rulesets: [], expected: "ask" },
  { name: "wildcard-deny", permission: "edit", pattern: "src/index.ts", rulesets: [denyEdit], expected: "deny" },
  { name: "wildcard-allow", permission: "edit", pattern: "src/index.ts", rulesets: [allowEdit], expected: "allow" },
  {
    name: "specific-deny-beats-broad-allow",
    permission: "edit",
    pattern: "src/secrets/token.ts",
    rulesets: [allowEdit, denySecrets],
    expected: "deny",
  },
  {
    name: "specific-deny-does-not-leak",
    permission: "edit",
    pattern: "src/app.ts",
    rulesets: [allowEdit, denySecrets],
    expected: "allow",
  },
  {
    name: "command-prefix-deny",
    permission: "bash",
    pattern: "rm -rf /",
    rulesets: [denyRm],
    expected: "deny",
  },
  { name: "command-prefix-spares-others", permission: "bash", pattern: "ls -la", rulesets: [denyRm], expected: "ask" },
  {
    name: "unrelated-permission-ignored",
    permission: "read",
    pattern: "docs/a.md",
    rulesets: [denyEdit],
    expected: "ask",
  },
  {
    name: "explicit-ask-overrides-allow",
    permission: "edit",
    pattern: "x.ts",
    rulesets: [allowEdit, [{ permission: "edit", pattern: "*", action: "ask" }]],
    expected: "ask",
  },
]

const PERMISSION_CASE: CaseDefinition = {
  id: "security.permission-matrix",
  category: "security",
  title: "Evaluate the permission matrix",
  description:
    "Runs the real permission evaluator over nine rule/pattern combinations (defaults, wildcards, specific denies, command prefixes, later-ruleset precedence).",
  metrics: { checks: "info", checks_ok: "higher", duration_ms: "lower" },
  run: () =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const failed: string[] = []
      for (const item of PERMISSION_MATRIX) {
        const decision = evaluate(item.permission, item.pattern, ...item.rulesets)
        if (decision.action !== item.expected) {
          failed.push(`${item.name}: expected ${item.expected}, got ${decision.action}`)
        }
      }
      const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
      const ok = PERMISSION_MATRIX.length - failed.length
      return {
        status: failed.length === 0 ? "pass" : "fail",
        metrics: {
          checks: informational(PERMISSION_MATRIX.length),
          checks_ok: higher(ok),
          duration_ms: lower(durationMs),
        },
        ...(failed.length === 0 ? {} : { detail: failed.join("; ") }),
      }
    }),
}

const MCP_POLICY_CASE: CaseDefinition = {
  id: "security.mcp-policy",
  category: "security",
  title: "Verify MCP sandbox, retry, and rate-limit primitives",
  description:
    "Checks that the local MCP sandbox strips credentials, confines cwd to the workspace, clamps retry attempts, and enforces the rolling-window rate limit.",
  metrics: { checks: "info", checks_ok: "higher", duration_ms: "lower" },
  run: () =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const checks: Array<{ name: string; ok: boolean }> = []
      const record = (name: string, ok: boolean) => checks.push({ name, ok })

      const sandbox = McpPolicy.sandboxEnvironment(
        { PATH: "C:/tools", HOME: "C:/home", OPENAI_API_KEY: "sk-test", MCP_EXTRA: "x" },
        { ALLOWED_BY_CONFIG: "1" },
      )
      record("sandbox-keeps-path", sandbox.PATH === "C:/tools")
      record("sandbox-keeps-home", sandbox.HOME === "C:/home")
      record("sandbox-drops-credentials", sandbox.OPENAI_API_KEY === undefined)
      record("sandbox-drops-unknown-vars", sandbox.MCP_EXTRA === undefined)
      record("sandbox-keeps-configured", sandbox.ALLOWED_BY_CONFIG === "1")

      const base = path.join(os.tmpdir(), "opencode-benchmark-sandbox")
      record("cwd-allows-child", McpPolicy.sandboxCwd(base, "child").ok)
      record("cwd-blocks-parent", !McpPolicy.sandboxCwd(base, path.join("..", "escape")).ok)

      record("retry-clamps-low", McpPolicy.retryPolicy({ attempts: 0 }).attempts === 1)
      record("retry-clamps-high", McpPolicy.retryPolicy({ attempts: 99 }).attempts === 10)
      record("retry-default-delay", McpPolicy.retryPolicy(undefined).delay === 250)
      record("rate-limit-requires-window", McpPolicy.rateLimitPolicy({ requests: 2 }) === undefined)
      record("rate-limit-accepts-pair", McpPolicy.rateLimitPolicy({ requests: 2, window: 1000 }) !== undefined)

      const limiter = new McpPolicy.Limiter({ requests: 2, window: 1000 })
      const first = limiter.take(0)
      const second = limiter.take(0)
      const blocked = limiter.take(0)
      const afterWindow = limiter.take(1000)
      record("limiter-allows-first", first.ok)
      record("limiter-allows-second", second.ok)
      record("limiter-blocks-third", !blocked.ok && blocked.retryAfterMs === 1000)
      record("limiter-window-rolls", afterWindow.ok)

      const ok = checks.filter((item) => item.ok).length
      const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
      return {
        status: ok === checks.length ? "pass" : "fail",
        metrics: {
          checks: informational(checks.length),
          checks_ok: higher(ok),
          duration_ms: lower(durationMs),
        },
        ...(ok === checks.length
          ? {}
          : {
              detail: `failed checks: ${checks
                .filter((item) => !item.ok)
                .map((item) => item.name)
                .join(", ")}`,
            }),
      }
    }),
}

const ROUTING_CASE: CaseDefinition = {
  id: "routing.model-routing",
  category: "routing",
  title: "Measure the live model routing decision",
  description:
    "Counts visible providers/models, how many are free and tool-capable, and records whether the resolved default model is free (the free-first policy target).",
  metrics: {
    providers: "info",
    models: "info",
    free_models: "info",
    toolcapable_models: "info",
    default_is_free: "higher",
    default_input_cost: "lower",
    default_output_cost: "lower",
    duration_ms: "lower",
  },
  run: (deps) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const providers = yield* deps.providers.list()
      const models = Object.values(providers).flatMap((provider) => Object.values(provider.models))
      const free = models.filter((model) => model.cost.input === 0 && model.cost.output === 0)
      const toolcapable = models.filter((model) => model.capabilities.toolcall)
      const base = {
        providers: informational(Object.keys(providers).length),
        models: informational(models.length),
        free_models: informational(free.length),
        toolcapable_models: informational(toolcapable.length),
      }

      const selected = yield* deps.providers.defaultModel().pipe(Effect.exit)
      if (Exit.isFailure(selected) || models.length === 0) {
        return {
          status: "unavailable",
          detail: `no default model resolved (${models.length} models visible)`,
          metrics: {
            ...base,
            duration_ms: lower(Math.round((yield* Clock.currentTimeMillis) - start)),
          },
        }
      }

      const choice = selected.value
      const model = yield* deps.providers.getModel(choice.providerID, choice.modelID).pipe(Effect.exit)
      const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
      if (Exit.isFailure(model)) {
        return {
          status: "unavailable",
          detail: `default model ${choice.modelID} is not resolvable`,
          metrics: { ...base, duration_ms: lower(durationMs) },
        }
      }

      const cost = model.value.cost
      const isFree = cost.input === 0 && cost.output === 0
      return {
        status: "pass",
        metrics: {
          ...base,
          default_is_free: higher(isFree ? 1 : 0),
          default_input_cost: lower(cost.input),
          default_output_cost: lower(cost.output),
          duration_ms: lower(durationMs),
        },
      }
    }),
}

const COST_TEXT = Array.from({ length: 6000 }, (_, index) => `line ${index} ${"x".repeat(48)}`).join("\n")

const COST_CASE: CaseDefinition = {
  id: "cost.truncate-budget",
  category: "cost",
  title: "Truncate oversized tool output within budget",
  description:
    "Runs the real truncate service over a large synthetic output and measures bytes and estimated tokens saved by the budget.",
  metrics: {
    input_bytes: "info",
    kept_bytes: "lower",
    saved_pct: "higher",
    truncated: "higher",
    tokens_in: "info",
    tokens_kept: "lower",
    duration_ms: "lower",
  },
  run: (deps) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const result = yield* deps.truncate.output(COST_TEXT, {})
      const durationMs = Math.round((yield* Clock.currentTimeMillis) - start)
      const encoder = new TextEncoder()
      const inputBytes = encoder.encode(COST_TEXT).length
      const keptBytes = encoder.encode(result.content).length
      const tokensIn = estimateTokens(COST_TEXT)
      const tokensKept = estimateTokens(result.content)
      const saved = inputBytes > 0 ? 100 * (1 - keptBytes / inputBytes) : 0
      const correct = result.truncated && keptBytes < inputBytes
      return {
        status: correct ? "pass" : "fail",
        metrics: {
          input_bytes: informational(inputBytes),
          kept_bytes: lower(keptBytes),
          saved_pct: higher(saved),
          truncated: higher(result.truncated ? 1 : 0),
          tokens_in: informational(tokensIn),
          tokens_kept: lower(tokensKept),
          duration_ms: lower(durationMs),
        },
        ...(correct ? {} : { detail: `truncated=${result.truncated} kept=${keptBytes}/${inputBytes} bytes` }),
      }
    }),
}

export const CASES: ReadonlyArray<CaseDefinition> = [
  CODING_CASE,
  DEBUGGING_CASE,
  REFACTORING_CASE,
  BROWSER_CASE,
  {
    id: "browser.dom-interaction",
    category: "browser",
    title: "Drive a real browser session",
    description:
      "DOM interaction (click, type, screenshot) needs a real browser session; declared unavailable instead of being estimated.",
    metrics: {},
    run: () =>
      unavailable("requires an interactive browser session (CDP backend); not available inside the benchmark runtime"),
  },
  {
    id: "ui.render-surface",
    category: "ui",
    title: "Render and assert the interactive TUI",
    description: "Rendering the TUI needs an interactive terminal; declared unavailable instead of being estimated.",
    metrics: {},
    run: () =>
      unavailable(
        "requires an interactive terminal renderer; TUI rendering is covered by the packages/tui and CLI view tests",
      ),
  },
  MULTI_AGENT_CASE,
  LONG_RUNNING_CASE,
  RECOVERY_CASE,
  CONTEXT_CASE,
  PERMISSION_CASE,
  MCP_POLICY_CASE,
  ROUTING_CASE,
  COST_CASE,
]

export function select(patterns?: readonly string[]): readonly CaseDefinition[] {
  if (patterns === undefined || patterns.length === 0) return CASES
  return CASES.filter((item) => patterns.includes(item.id) || patterns.includes(item.category))
}

export function directions(): Record<string, Record<string, Direction>> {
  return Object.fromEntries(CASES.map((item) => [item.id, item.metrics]))
}

export * as Cases from "./cases"
