import { errorFormat, errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"

/**
 * User-facing failure report.
 *
 * Every field has to be present so a caller never falls back to a generic
 * "something went wrong" message. Callers provide the operation context; this
 * module fills in the reason and an actionable next step.
 */
export type Report = {
  what: string
  why: string
  where: string
  attempted: string
  result: string
  nextAction: string
}

export type Context = {
  /** Short failure summary. Defaults to a classification of the error. */
  what?: string
  /** Detailed reason. Use FormatError's output for known domain errors. */
  detail?: string
  /** Command, tool, or subsystem where the failure happened. */
  where?: string
  /** Human-readable action(s) that were attempted. */
  attempted?: string | readonly string[]
  /** What actually happened after the attempt. */
  result?: string
  /** Actionable recovery step. */
  nextAction?: string
}

export function from(input: unknown, context: Context = {}): Report {
  const tag = tagOf(input)
  const detail = detailOf(input, context.detail)
  return {
    what: text(context.what) ?? classify(tag, detail),
    why: text(detail) ?? "No error message was provided by the failing component.",
    where: text(context.where) ?? "opencode",
    attempted: attempts(context.attempted),
    result: text(context.result) ?? "The requested operation did not complete.",
    nextAction: text(context.nextAction) ?? suggest(tag, detail),
  }
}

export function render(report: Report): string {
  return [
    line("WHAT", report.what),
    line("WHY", report.why),
    line("WHERE", report.where),
    line("ATTEMPTED", report.attempted),
    line("RESULT", report.result),
    line("NEXT ACTION", report.nextAction),
  ].join("\n")
}

export function format(input: unknown, context: Context = {}): string {
  return render(from(input, context))
}

function line(label: string, value: string) {
  const [first, ...rest] = value.trim().split("\n")
  return [`${label}: ${first}`, ...rest.map((item) => `  ${item}`)].join("\n")
}

function text(value?: string) {
  const result = value?.trim()
  return result ? result : undefined
}

function attempts(value?: string | readonly string[]) {
  const values = (typeof value === "string" ? [value] : (value ?? [])).map((item) => item.trim()).filter(Boolean)
  return values.length ? values.join("; ") : "Execute the requested operation."
}

function tagOf(input: unknown) {
  if (isRecord(input)) {
    if (typeof input._tag === "string" && input._tag) return input._tag
    if (typeof input.name === "string" && input.name) return input.name
    return undefined
  }
  if (input instanceof Error && input.name) return input.name
  return undefined
}

function detailOf(input: unknown, detail?: string) {
  const provided = text(detail)
  if (provided) return provided
  if (input === undefined || input === null) return ""
  if (input instanceof Error) {
    const message = errorMessage(input)
    if (input.cause === undefined) return message
    const cause = errorMessage(input.cause)
    return cause && cause !== message && cause !== "unknown error" ? `${message}\nCaused by: ${cause}` : message
  }
  const message = errorMessage(input)
  if (message && message !== "unknown error") return message
  const formatted = errorFormat(input)
  return formatted === "Error (no message)" ? "" : formatted
}

const BuiltinErrors = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
])

function classify(tag: string | undefined, detail: string) {
  const haystack = `${tag ?? ""}\n${detail}`.toLowerCase()
  if (tag === "ProviderModelNotFoundError") return "Provider model not found"
  if (tag === "ProviderInitError" || tag === "ProviderAuthError") {
    return "Provider authentication or initialization failed"
  }
  if (tag === "CliError") return "Command failed"
  if (tag === "AccountServiceError" || tag === "AccountTransportError") return "Account service request failed"
  if (tag?.startsWith("Config")) return "Configuration error"
  if (tag === "MCPFailed") return "MCP server failed"
  if (tag === "ToolInvalidArgumentsError") return "Invalid tool arguments"
  if (tag === "MessageAbortedError" || tag === "UICancelledError") return "Operation cancelled"
  if (isNetwork(haystack)) return "Unable to reach the remote service"
  if (isTimeout(haystack)) return "Operation timed out"
  if (isPermission(haystack)) return "Permission denied"
  if (/model.*not found|not found.*model/.test(haystack)) return "Provider model not found"
  if (isAuth(haystack)) return "Authentication failed"
  if (isNotFound(haystack)) return "Required resource not found"
  if (isInvalidArguments(haystack)) return "Invalid tool arguments"
  if (isCancelled(haystack)) return "Operation cancelled"
  if (tag && !BuiltinErrors.has(tag) && tag !== "UnknownError") return humanize(tag)
  return "Operation failed"
}

function suggest(tag: string | undefined, detail: string) {
  const haystack = `${tag ?? ""}\n${detail}`.toLowerCase()
  if (tag === "ProviderModelNotFoundError") {
    return "Run `opencode models` to list available models, then update the provider/model in your config or command."
  }
  if (tag === "ProviderInitError" || tag === "ProviderAuthError") {
    return "Check the provider credentials with `opencode auth list`, then run `opencode auth login <provider>` if needed."
  }
  if (tag === "CliError") {
    return "Fix the command arguments or environment described in WHY, then retry."
  }
  if (tag === "AccountServiceError" || tag === "AccountTransportError") {
    return "Check your network and account configuration, then retry. If the service is unavailable, try again later."
  }
  if (tag?.startsWith("Config")) {
    return "Fix the configuration file named in WHY and run the command again. Use `opencode debug config` to inspect the resolved configuration."
  }
  if (tag === "MCPFailed") {
    return "Run `opencode mcp list` and check the failing server command or URL in your config, then retry."
  }
  if (tag === "ToolInvalidArgumentsError" || isInvalidArguments(haystack)) {
    return "Correct the tool arguments to match its schema, then retry."
  }
  if (tag === "MessageAbortedError" || tag === "UICancelledError" || isCancelled(haystack)) {
    return "No action is needed if the cancellation was intentional; otherwise retry the command."
  }
  if (isNetwork(haystack)) {
    return "Check the remote URL, network, proxy, or VPN configuration, then retry. Include WHERE and the exact error from WHY if it persists."
  }
  if (isTimeout(haystack)) {
    return "Retry with a longer timeout or a smaller request. If the failure persists, check the remote service health."
  }
  if (isPermission(haystack)) {
    return "Grant the required permission or choose an allowed path/command, then retry."
  }
  if (/model.*not found|not found.*model/.test(haystack)) {
    return "Run `opencode models` to list available models, then update the provider/model in your config or command."
  }
  if (isAuth(haystack)) {
    return "Check the provider credentials and authentication configuration, then retry."
  }
  if (isNotFound(haystack)) {
    return "Verify that the path or resource named in WHY exists and is accessible, then retry."
  }
  return "Inspect WHY and WHERE, correct the underlying cause, then retry. If it persists, re-run with `--print-logs` and include this report."
}

function isNetwork(value: string) {
  return /(econnrefused|connectionrefused|connection refused|connection reset|unable to connect|fetch failed|socket hang up|network error|enotfound|eai_again)/.test(
    value,
  )
}

function isTimeout(value: string) {
  return /(timed? ?out|etimedout|timeout)/.test(value)
}

function isPermission(value: string) {
  return /(permission|eacces|denied|rejected)/.test(value)
}

function isNotFound(value: string) {
  return /(enoent|no such file|not found)/.test(value)
}

function isAuth(value: string) {
  return /(401|403|unauthorized|authentication|credential|api key|invalid key)/.test(value)
}

function isInvalidArguments(value: string) {
  return /(invalid.*argument|argument.*invalid|validation)/.test(value)
}

function isCancelled(value: string) {
  return /(abort|cancel)/.test(value)
}

function humanize(tag: string) {
  return tag
    .replace(/Error$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim()
}

export * as ErrorReport from "./report"
