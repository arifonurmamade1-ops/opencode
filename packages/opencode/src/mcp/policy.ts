import path from "node:path"

// Access policy primitives for MCP servers: retry, rate limiting, and the
// sandbox applied to local servers. Everything in this module is pure so the
// behavior can be tested without spawning a server.

export type RetryPolicy = {
  attempts: number
  delay: number
}

export type RateLimitPolicy = {
  requests: number
  window: number
}

export type Counters = {
  calls: number
  succeeded: number
  failed: number
  retries: number
  rateLimited: number
  connects: number
  connectFailures: number
}

const MAX_ATTEMPTS = 10
const DEFAULT_DELAY = 250

export function counters(): Counters {
  return {
    calls: 0,
    succeeded: 0,
    failed: 0,
    retries: 0,
    rateLimited: 0,
    connects: 0,
    connectFailures: 0,
  }
}

export function retryPolicy(input?: { attempts?: number; delay?: number }): RetryPolicy {
  return {
    attempts: clamp(input?.attempts ?? 1, 1, MAX_ATTEMPTS),
    delay: clamp(input?.delay ?? DEFAULT_DELAY, 0, Number.MAX_SAFE_INTEGER),
  }
}

export function rateLimitPolicy(input?: { requests?: number; window?: number }): RateLimitPolicy | undefined {
  if (!input?.requests || !input.window) return undefined
  return {
    requests: clamp(input.requests, 1, Number.MAX_SAFE_INTEGER),
    window: clamp(input.window, 1, Number.MAX_SAFE_INTEGER),
  }
}

/** Raised when a call is rejected by the server's rate limit. Never retried. */
export class LimitError extends Error {
  readonly retryAfterMs: number
  constructor(retryAfterMs: number, detail?: string) {
    super(`${detail ?? "MCP rate limit exceeded"}; retry after ${retryAfterMs}ms`)
    this.retryAfterMs = retryAfterMs
  }
}

/** Raised when a tool call reports a tool-level error. Never retried: replaying can repeat side effects. */
export class ToolError extends Error {}

/** Tool-level failures and rate limits are final; transport errors are retryable. */
export function retryable(error: unknown): boolean {
  return !(error instanceof LimitError) && !(error instanceof ToolError)
}

export type RetryEvent = {
  attempt: number
  error: unknown
  delay: number
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  options?: {
    retryable?: (error: unknown) => boolean
    onRetry?: (event: RetryEvent) => void
    sleep?: (ms: number) => Promise<void>
  },
): Promise<T> {
  const canRetry = options?.retryable ?? retryable
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let attempt = 1
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= policy.attempts || !canRetry(error)) throw error
      options?.onRetry?.({ attempt, error, delay: policy.delay })
      if (policy.delay > 0) await sleep(policy.delay)
      attempt += 1
    }
  }
}

/** Rolling-window limiter: at most `requests` claims per `window` milliseconds. */
export class Limiter {
  private hits: number[] = []
  constructor(readonly policy: RateLimitPolicy) {}

  get used() {
    return this.hits.length
  }

  take(now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const cutoff = now - this.policy.window
    while (this.hits.length > 0 && this.hits[0]! <= cutoff) this.hits.shift()
    if (this.hits.length >= this.policy.requests) {
      return { ok: false, retryAfterMs: Math.max(1, this.hits[0]! + this.policy.window - now) }
    }
    this.hits.push(now)
    return { ok: true }
  }
}

// A sandboxed local server only inherits the variables needed to start a
// process and find tools; credentials and other operator state stay out unless
// the server config asks for them explicitly.
const SANDBOX_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
])

export function sandboxEnvironment(
  base?: Record<string, string | undefined>,
  configured?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base ?? {})) {
    if (value === undefined || !SANDBOX_ENV_KEYS.has(key.toUpperCase())) continue
    env[key] = value
  }
  return { ...env, ...configured }
}

export function sandboxCwd(base: string, cwd?: string): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = cwd ? path.resolve(base, cwd) : path.resolve(base)
  const relative = path.relative(path.resolve(base), resolved)
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  if (!inside) {
    return { ok: false, error: `sandboxed server cwd must stay inside the workspace: ${resolved}` }
  }
  return { ok: true, path: resolved }
}

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

export * as McpPolicy from "./policy"
