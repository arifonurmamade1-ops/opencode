export * as PluginApi from "./api"

import { PLUGIN_API_VERSION, type Hooks } from "@opencode-ai/plugin"

// Stable external-plugin contract for this build.
//
// A plugin is only as trustworthy as the hooks object it returns, so every
// object handed back by a plugin is validated here before it is registered.
// Broken plugins are skipped with an explicit reason instead of half-loading
// and taking core paths down with them later.

/** Plugin API version implemented by this build. */
export const API_VERSION = PLUGIN_API_VERSION

/** Extension points a plugin can contribute to, derived from its hooks. */
export type Capability = "tools" | "providers" | "hooks" | "config"

export type Status = "loaded" | "skipped" | "failed"

export type Source = "internal" | "file" | "npm"

export type PluginRecord = {
  /** Stable plugin identity (module id for v1 modules, spec/package name otherwise). */
  id: string
  /** Config spec this plugin was resolved from ("internal" for built-ins). */
  spec: string
  source: Source
  /** Plugin API version the plugin targets (explicit or assumed). */
  api: number
  status: Status
  capabilities: Capability[]
  /** Implemented lifecycle/trigger hooks, excluding tools and provider hooks. */
  hooks: string[]
  /** Tool ids contributed by this plugin. */
  tools: string[]
  /** Why the plugin was skipped or failed. */
  error?: string
}

export type Description = {
  capabilities: Capability[]
  hooks: string[]
  tools: string[]
}

const CAPABILITY_ORDER: readonly Capability[] = ["tools", "providers", "hooks", "config"]

// Hooks with the (input, output) => Promise<void> trigger shape.
const TRIGGER_HOOKS = [
  "chat.message",
  "chat.params",
  "chat.headers",
  "permission.ask",
  "command.execute.before",
  "tool.execute.before",
  "tool.execute.after",
  "shell.env",
  "tool.definition",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.provider.small_model",
  "experimental.session.compacting",
  "experimental.compaction.autocontinue",
  "experimental.text.complete",
] as const

// Lifecycle callbacks plugins can implement. `dispose` is validated but not
// reported as a hook because it does not extend the agent.
const CALLBACK_HOOKS = ["event", "config", "dispose"] as const

const REPORTED_HOOKS = ["config", "event", ...TRIGGER_HOOKS] as const

/** Describe what a plugin contributes without running it. */
export function describe(input: Hooks | readonly Hooks[]): Description {
  const list = Array.isArray(input) ? input : [input]
  const found = new Set<Capability>()
  const hooks = new Set<string>()
  const tools = new Set<string>()

  for (const entry of list) {
    const record = asRecord(entry)
    if (!record) continue
    for (const name of Object.keys(asRecord(record.tool) ?? {})) tools.add(name)
    if (tools.size) found.add("tools")
    if (record.auth !== undefined || record.provider !== undefined) found.add("providers")
    if (record.config !== undefined) found.add("config")
    for (const name of REPORTED_HOOKS) if (record[name] !== undefined) hooks.add(name)
    if (hooks.size) found.add("hooks")
  }

  return {
    capabilities: CAPABILITY_ORDER.filter((capability) => found.has(capability)),
    hooks: [...hooks].sort(),
    tools: [...tools].sort(),
  }
}

/**
 * Structurally validate a hooks object returned by a plugin.
 *
 * Unknown keys are ignored so future API additions stay forward compatible,
 * but a malformed known key is a problem: keeping such a plugin loaded would
 * break every trigger site that reads the hook.
 */
export function validate(hooks: unknown): string[] {
  const record = asRecord(hooks)
  if (!record) return ["it must return a hooks object"]

  const problems: string[] = []
  for (const name of [...CALLBACK_HOOKS, ...TRIGGER_HOOKS]) {
    const value = record[name]
    if (value !== undefined && typeof value !== "function") problems.push(`"${name}" must be a function`)
  }

  if (record.tool !== undefined) {
    const defs = asRecord(record.tool)
    if (!defs) problems.push(`"tool" must be an object of tool definitions`)
    else {
      for (const [id, def] of Object.entries(defs)) {
        const entry = asRecord(def)
        if (!entry) {
          problems.push(`tool "${id}" must be an object`)
          continue
        }
        if (typeof entry.description !== "string") problems.push(`tool "${id}" must have a string "description"`)
        if (!asRecord(entry.args)) problems.push(`tool "${id}" must have an "args" object`)
        if (typeof entry.execute !== "function") problems.push(`tool "${id}" must have an "execute" function`)
      }
    }
  }

  if (record.auth !== undefined) {
    const auth = asRecord(record.auth)
    if (!auth) problems.push(`"auth" must be an object`)
    else {
      if (typeof auth.provider !== "string") problems.push(`"auth" must have a string "provider"`)
      if (!Array.isArray(auth.methods)) problems.push(`"auth" must have a "methods" array`)
    }
  }

  if (record.provider !== undefined) {
    const provider = asRecord(record.provider)
    if (!provider) problems.push(`"provider" must be an object`)
    else if (typeof provider.id !== "string") problems.push(`"provider" must have a string "id"`)
  }

  return problems
}

/** Compatibility policy for a declared plugin API version. */
export function apiVersionProblem(declared: number | undefined): string | undefined {
  if (declared === undefined) return
  if (!Number.isInteger(declared) || declared < 1) return `declares an invalid plugin API version (${declared})`
  if (declared > API_VERSION) return `requires plugin API v${declared} but this build implements v${API_VERSION}`
  return
}

/** Render a plugin inventory for humans and models. */
export function format(records: readonly PluginRecord[]): string {
  if (!records.length) return `No plugins are known to this project (plugin API v${API_VERSION}).`

  const loaded = records.filter((record) => record.status === "loaded").length
  const skipped = records.filter((record) => record.status === "skipped").length
  const failed = records.length - loaded - skipped
  const header = `${records.length} plugin(s) known: ${loaded} loaded, ${skipped} skipped, ${failed} failed (plugin API v${API_VERSION})`
  const lines = records.toSorted((a, b) => a.id.localeCompare(b.id)).map(line)
  return [header, "", ...lines].join("\n")
}

function line(record: PluginRecord) {
  const head = `- ${record.id} (${record.source}, api v${record.api})`
  if (record.status === "skipped") return `${head} [skipped] ${record.error ?? "unknown reason"}`
  if (record.status === "failed") return `${head} [failed] ${record.error ?? "unknown error"}`
  const parts: string[] = []
  if (record.tools.length) parts.push(`tools: ${record.tools.join(", ")}`)
  if (record.hooks.length) parts.push(`hooks: ${record.hooks.join(", ")}`)
  if (!parts.length) parts.push("no extension points")
  return `${head} [loaded] ${parts.join("; ")}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
