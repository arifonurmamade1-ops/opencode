import path from "path"
import os from "os"
import { existsSync } from "node:fs"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel, InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { which } from "@opencode-ai/core/util/which"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Auth } from "@/auth"
import { FormatError } from "@/cli/error"
import { ConfigParse } from "@/config/parse"
import { ConfigV2Compat } from "@/config/v2-compat"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { mergeDeep } from "remeda"

export type Status = "ok" | "warn" | "fail" | "skip"

export type Check = {
  id: string
  title: string
  status: Status
  summary: string
  details?: string[]
  nextAction?: string
}

export type Report = {
  version: string
  directory: string
  checks: Check[]
  summary: Record<Status, number>
}

export type Input = {
  directory: string
  network?: boolean
}

type Catalog = Record<string, ModelsDev.Provider>
type Credentials = Record<string, unknown>
type ConfigScan = {
  effective: ConfigV1.Info
  files: string[]
  loaded: number
  details: string[]
  errors: string[]
  warnings: string[]
}

export async function run(input: Input): Promise<Report> {
  const worktree = gitRoot(input.directory)
  const config = await scanConfig(input.directory, worktree)
  const catalog = ModelsDev.snapshot() ?? {}
  const credentials = await loadCredentials()
  const checks: Check[] = [
    configCheck(config),
    providerCheck(config.effective, catalog, credentials),
    modelCheck(config.effective, catalog, credentials),
    await apiCheck(config.effective, catalog, credentials, input.network ?? false),
    mcpCheck(config.effective),
    browserCheck(),
    lspCheck(config.effective),
    gitCheck(input.directory),
    permissionCheck(config.effective),
    sandboxCheck(config.effective),
    await storageCheck(),
    dependencyCheck(),
  ]
  return report(input.directory, checks)
}

export function render(report: Report) {
  const lines = ["opencode doctor", `directory: ${report.directory}`, ""]
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.title}: ${check.summary}`)
    for (const detail of check.details ?? []) lines.push(`   ${detail}`)
    if (check.status !== "ok" && check.nextAction) lines.push(`   NEXT ACTION: ${check.nextAction}`)
  }
  lines.push(
    "",
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warning${report.summary.warn === 1 ? "" : "s"}, ${report.summary.fail} failure${report.summary.fail === 1 ? "" : "s"}, ${report.summary.skip} skipped`,
  )
  return lines.join("\n")
}

export function exitCode(report: Report) {
  return report.summary.fail > 0 ? 1 : 0
}

function report(directory: string, checks: Check[]): Report {
  return {
    version: InstallationVersion,
    directory,
    checks,
    summary: {
      ok: checks.filter((check) => check.status === "ok").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length,
      skip: checks.filter((check) => check.status === "skip").length,
    },
  }
}

async function scanConfig(directory: string, worktree: string | undefined): Promise<ConfigScan> {
  const files = configFiles(directory, worktree)
  let effective: ConfigV1.Info = {}
  let loaded = 0
  const details: string[] = []
  const errors: string[] = []
  const warnings: string[] = []

  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) {
      errors.push(`${file}: the file exists but could not be read.`)
      continue
    }
    try {
      const parsed = parseConfig(text, file)
      if (parsed.diagnostics.length) {
        warnings.push(
          `${file}: ${parsed.diagnostics.length} compatibility warning${parsed.diagnostics.length === 1 ? "" : "s"}`,
        )
        details.push(...parsed.diagnostics.map((diagnostic) => `${file}: ${diagnostic.message}`))
      }
      effective = mergeDeep(effective, parsed.config) as ConfigV1.Info
      loaded += 1
      details.push(`${file}: valid`)
    } catch (error) {
      errors.push(`${file}: ${formatConfigFailure(error)}`)
    }
  }

  if (Flag.OPENCODE_CONFIG_CONTENT) {
    try {
      const parsed = parseConfig(Flag.OPENCODE_CONFIG_CONTENT, "<OPENCODE_CONFIG_CONTENT>")
      effective = mergeDeep(effective, parsed.config) as ConfigV1.Info
      loaded += 1
      details.push("<OPENCODE_CONFIG_CONTENT>: valid")
      if (parsed.diagnostics.length) {
        details.push(
          ...parsed.diagnostics.map((diagnostic) => `<OPENCODE_CONFIG_CONTENT>: ${diagnostic.message}`),
        )
      }
    } catch (error) {
      errors.push(`<OPENCODE_CONFIG_CONTENT>: ${formatConfigFailure(error)}`)
    }
  }

  return {
    effective,
    files,
    loaded,
    details: details.slice(-12),
    errors,
    warnings,
  }
}

function configFiles(directory: string, worktree: string | undefined) {
  const candidates: string[] = []
  const configDir = Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    candidates.push(path.join(configDir, name))
  }
  if (Flag.OPENCODE_CONFIG) candidates.push(Flag.OPENCODE_CONFIG)
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    candidates.push(...filesUp(directory, worktree, ["opencode.jsonc", "opencode.json"]).toReversed())
  }
  for (const dir of configDirectories(directory, worktree)) {
    candidates.push(path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc"))
  }
  return [...new Set(candidates)].filter((file) => existsSync(file))
}

function filesUp(directory: string, worktree: string | undefined, names: string[]) {
  const result: string[] = []
  let current = path.resolve(directory)
  const stop = stopDirectory(directory, worktree)
  while (true) {
    for (const name of names) result.push(path.join(current, name))
    if (current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
}

function stopDirectory(directory: string, worktree: string | undefined) {
  if (worktree) return path.resolve(worktree)
  return path.parse(path.resolve(directory)).root
}

function configDirectories(directory: string, worktree: string | undefined) {
  const result = new Set<string>()
  result.add(Global.Path.config)
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    let current = path.resolve(directory)
    const stop = stopDirectory(directory, worktree)
    while (true) {
      result.add(path.join(current, ".opencode"))
      if (current === stop) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  result.add(path.join(Global.Path.home, ".opencode"))
  if (Flag.OPENCODE_CONFIG_DIR) result.add(Flag.OPENCODE_CONFIG_DIR)
  return [...result].filter(
    (dir) => dir.endsWith(".opencode") || dir === Global.Path.config || dir === Flag.OPENCODE_CONFIG_DIR,
  )
}

function parseConfig(text: string, file: string) {
  const raw = ConfigParse.jsonc(text, file)
  const normalized = normalizeConfig(raw)
  const lowered = ConfigV2Compat.lower(normalized, file)
  return {
    config: ConfigParse.schema(ConfigV1.Info, lowered.value, file) as ConfigV1.Info,
    diagnostics: lowered.diagnostics,
  }
}

function normalizeConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  if ("theme" in copy || "keybinds" in copy || "tui" in copy) {
    delete copy.theme
    delete copy.keybinds
    delete copy.tui
  }
  return copy
}

function configCheck(scan: ConfigScan): Check {
  if (scan.errors.length) {
    return {
      id: "config",
      title: "Configuration",
      status: "fail",
      summary: `${scan.errors.length} configuration file${scan.errors.length === 1 ? "" : "s"} could not be loaded.`,
      details: scan.errors.slice(0, 8),
      nextAction:
        "Fix the file named above, then run `opencode doctor` again. The report names the syntax or schema problem so you can correct it without loading the project.",
    }
  }
  if (!scan.loaded) {
    return {
      id: "config",
      title: "Configuration",
      status: "warn",
      summary: "No configuration files found; built-in defaults are in use.",
      details: scan.details,
      nextAction:
        "Create `opencode.json` in the project or global config directory when you need project-specific settings.",
    }
  }
  return {
    id: "config",
    title: "Configuration",
    status: scan.warnings.length ? "warn" : "ok",
    summary: `${scan.loaded} configuration file${scan.loaded === 1 ? "" : "s"} loaded.`,
    details: scan.details,
    ...(scan.warnings.length
      ? { nextAction: "Review the compatibility warnings above and update the deprecated fields." }
      : {}),
  }
}

async function loadCredentials(): Promise<Credentials> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      const data = JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
      return isRecord(data) ? data : {}
    } catch {
      return {}
    }
  }
  try {
    const data = JSON.parse(await readFile(Auth.filepath(), "utf8"))
    return isRecord(data) ? data : {}
  } catch {
    return {}
  }
}

function providerCheck(config: ConfigV1.Info, catalog: Catalog, credentials: Credentials): Check {
  const providers = providerMap(config, catalog)
  const disabled = new Set(config.disabled_providers ?? [])
  const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
  const configured = configuredProviders(config, catalog, credentials)
  const available = [...configured].filter(
    (id) => providers[id] && !disabled.has(id) && (!enabled || enabled.has(id)),
  )
  if (!available.length) {
    return {
      id: "providers",
      title: "Providers",
      status: "fail",
      summary: "No configured or authenticated providers are enabled.",
      details: [
        ...(enabled ? [`enabled_providers: ${[...enabled].join(", ")}`] : []),
        ...(disabled.size ? [`disabled_providers: ${[...disabled].join(", ")}`] : []),
      ],
      nextAction:
        "Configure a provider or remove the restrictive `enabled_providers`/`disabled_providers` entry, then run `opencode auth login`.",
    }
  }
  const connected = available.filter((id) => isConnected(id, providers[id], config, credentials))
  const explicit = new Set(Object.keys(config.provider ?? {}))
  const unverified = available.filter((id) => explicit.has(id) && !connected.includes(id))
  const missingEnv = available
    .filter((id) => !connected.includes(id))
    .flatMap((id) => providerEnv(id, providers[id], config))
  const details = available.slice(0, 8).map(
    (id) =>
      `${id}: ${Object.keys(providers[id].models).length} model${Object.keys(providers[id].models).length === 1 ? "" : "s"}${
        connected.includes(id)
          ? ", credentials detected"
          : explicit.has(id)
            ? ", configured without detected credentials"
            : ", no credentials detected"
      }`,
  )
  if (available.length > 8) details.push(`... and ${available.length - 8} more`)
  if (missingEnv.length) details.push(`Environment variables checked: ${[...new Set(missingEnv)].join(", ")}`)
  if (!connected.length && !unverified.length) {
    return {
      id: "providers",
      title: "Providers",
      status: "fail",
      summary: "No provider credentials were detected.",
      details,
      nextAction: "Run `opencode auth login`, or set one of the provider environment variables listed above.",
    }
  }
  if (!connected.length) {
    return {
      id: "providers",
      title: "Providers",
      status: "warn",
      summary: `${unverified.length} explicitly configured provider${unverified.length === 1 ? " has" : "s have"} no detected credentials.`,
      details,
      nextAction:
        "Verify these providers work as configured. Add `options.apiKey` or the provider environment variable if they require authentication.",
    }
  }
  return {
    id: "providers",
    title: "Providers",
    status: "ok",
    summary: `${connected.length} of ${available.length} enabled provider${available.length === 1 ? " has" : "s have"} credentials.`,
    details,
  }
}

function modelCheck(config: ConfigV1.Info, catalog: Catalog, credentials: Credentials): Check {
  const providers = providerMap(config, catalog)
  const details: string[] = []
  const failures: string[] = []
  let status: Status = "ok"
  let summary = "Configured models resolve against the provider catalog."

  for (const [label, value] of [
    ["model", config.model],
    ["small_model", config.small_model],
  ] as const) {
    if (!value) continue
    const parsed = splitModel(value)
    if (!parsed) {
      failures.push(`${label}: "${value}" is not in provider/model format.`)
      continue
    }
    const provider = providers[parsed.providerID]
    if (!provider) {
      failures.push(`${label}: provider "${parsed.providerID}" was not found.`)
      continue
    }
    if (!provider.models[parsed.modelID]) {
      failures.push(`${label}: model "${parsed.modelID}" was not found for provider "${parsed.providerID}".`)
      continue
    }
    details.push(`${label}: ${value} (resolved)`)
  }

  if (!config.model) {
    status = "warn"
    summary = "No default model is configured; a model will be selected at runtime."
    details.push("Set `model` to a `provider/model` value to make runs deterministic.")
  }
  if (failures.length) {
    status = "fail"
    summary = "One or more configured models could not be resolved."
    details.unshift(...failures)
  } else if (status === "ok") {
    const count = Object.values(providers).reduce((total, provider) => total + Object.keys(provider.models).length, 0)
    const providerCount = Object.keys(providers).length
    details.push(
      `${count} model${count === 1 ? "" : "s"} available across ${providerCount} provider${providerCount === 1 ? "" : "s"}.`,
    )
  } else if (Object.keys(credentials).length) {
    details.push(`${Object.keys(credentials).length} provider credential${Object.keys(credentials).length === 1 ? "" : "s"} found.`)
  }

  return {
    id: "models",
    title: "Models",
    status,
    summary,
    details: details.slice(0, 8),
    ...(status === "fail"
      ? { nextAction: "Run `opencode models` and update `model`/`small_model` in your config to a listed provider/model." }
      : status === "warn"
        ? { nextAction: "Run `opencode models`, then set `model` in your config." }
        : {}),
  }
}

async function apiCheck(
  config: ConfigV1.Info,
  catalog: Catalog,
  credentials: Credentials,
  network: boolean,
): Promise<Check> {
  const providers = providerMap(config, catalog)
  const configured = new Set(Object.keys(config.provider ?? {}))
  const endpoints = new Map<string, string[]>()
  for (const [id, provider] of Object.entries(providers)) {
    if (!isConnected(id, provider, config, credentials) && !configured.has(id)) continue
    const url = provider.api ?? ""
    if (!url) continue
    endpoints.set(url, [...(endpoints.get(url) ?? []), id])
  }
  const templates = new Set([...endpoints.keys()].filter(isTemplateUrl))
  const invalid = [...endpoints.keys()].filter((url) => !templates.has(url) && !isHttpUrl(url))
  if (invalid.length) {
    return {
      id: "apis",
      title: "APIs",
      status: "fail",
      summary: `${invalid.length} configured API endpoint${invalid.length === 1 ? "" : "s"} are not valid HTTP(S) URLs.`,
      details: invalid.slice(0, 8).map(displayUrl),
      nextAction: "Fix the provider `api` or `options.baseURL` value in your config.",
    }
  }
  if (!endpoints.size) {
    return {
      id: "apis",
      title: "APIs",
      status: "skip",
      summary: "No explicit API endpoints are configured; providers use their built-in defaults.",
      nextAction: "Nothing to do unless you expected a custom endpoint.",
    }
  }
  if (!network) {
    return {
      id: "apis",
      title: "APIs",
      status: "skip",
      summary: `${endpoints.size} configured endpoint${endpoints.size === 1 ? "" : "s"} not probed.`,
      details: [...endpoints.keys()].slice(0, 8).map(
        (url) =>
          `${displayUrl(url)} (${endpoints.get(url)!.join(", ")})${templates.has(url) ? " [unresolved template]" : ""}`,
      ),
      nextAction: "Run `opencode doctor --network` to probe reachability. The probe sends no credentials.",
    }
  }
  const targets = [...endpoints.entries()].filter(([url]) => !templates.has(url)).slice(0, 5)
  if (!targets.length) {
    return {
      id: "apis",
      title: "APIs",
      status: "skip",
      summary: "All configured endpoints use environment-variable templates and were not probed.",
      details: [...templates].slice(0, 8).map(displayUrl),
      nextAction: "Set the referenced environment variables, then retry `opencode doctor --network`.",
    }
  }
  const results = await Promise.all(
    targets.map(async ([url, ids]) => {
      try {
        const response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        })
        await response.body?.cancel()
        return { url, ids, ok: true as const, status: response.status }
      } catch (error) {
        return { url, ids, ok: false as const, error: errorMessage(error) }
      }
    }),
  )
  const failed = results.filter((result) => !result.ok)
  const details = results.map(
    (result) =>
      `${displayUrl(result.url)} (${result.ids.join(", ")}): ${result.ok ? `HTTP ${result.status}` : result.error}`,
  )
  return {
    id: "apis",
    title: "APIs",
    status: failed.length === results.length ? "fail" : failed.length ? "warn" : "ok",
    summary: failed.length
      ? `${failed.length} of ${results.length} probed endpoint${results.length === 1 ? "" : "s"} were unreachable.`
      : `${results.length} probed endpoint${results.length === 1 ? "" : "s"} responded.`,
    details: [
      ...details,
      ...(targets.length < endpoints.size - templates.size
        ? [`Probed first ${targets.length} of ${endpoints.size - templates.size} endpoints.`]
        : []),
      ...[...templates].map((url) => `${url} [unresolved template; not probed]`),
    ].slice(0, 10),
    nextAction: failed.length
      ? "Check the endpoint URL, network, proxy, or VPN configuration, then retry. A 401/403 response still means the endpoint is reachable."
      : undefined,
  }
}

function mcpCheck(config: ConfigV1.Info): Check {
  const entries = Object.entries(config.mcp ?? {})
  if (!entries.length) {
    return {
      id: "mcp",
      title: "MCP",
      status: "ok",
      summary: "No MCP servers are configured.",
      nextAction: "Configure an MCP server if you need external tools or resources.",
    }
  }
  const details: string[] = []
  const errors: string[] = []
  let local = 0
  let remote = 0
  let disabled = 0
  let sandboxed = 0
  for (const [name, value] of entries) {
    if (!isRecord(value)) continue
    const entry = value as Record<string, unknown>
    if (entry.enabled === false) {
      disabled += 1
      details.push(`${name}: disabled`)
      continue
    }
    if (entry.type === "local") {
      local += 1
      const command = Array.isArray(entry.command) ? entry.command : []
      const bin = typeof command[0] === "string" ? command[0] : undefined
      if (!bin) {
        errors.push(`${name}: local server has no command.`)
      } else if (isTemplateUrl(bin)) {
        details.push(`${name}: local (${bin}, unresolved template)`)
      } else if (!commandExists(bin)) {
        errors.push(`${name}: command "${bin}" was not found on PATH.`)
      } else {
        details.push(`${name}: local (${bin})`)
      }
      if (entry.sandbox === true) sandboxed += 1
      continue
    }
    if (entry.type === "remote") {
      remote += 1
      if (typeof entry.url !== "string") {
        errors.push(`${name}: remote server has no URL.`)
      } else if (isTemplateUrl(entry.url)) {
        details.push(`${name}: remote (${displayUrl(entry.url)}, unresolved template)`)
      } else if (!isHttpUrl(entry.url)) {
        errors.push(`${name}: remote URL is not a valid HTTP(S) URL.`)
      } else {
        details.push(`${name}: remote (${displayUrl(entry.url)})`)
      }
      continue
    }
    details.push(`${name}: unknown server type`)
  }
  if (errors.length) {
    return {
      id: "mcp",
      title: "MCP",
      status: "fail",
      summary: `${errors.length} MCP server${errors.length === 1 ? "" : "s"} have configuration problems.`,
      details: [...errors, ...details].slice(0, 10),
      nextAction: "Install missing commands or fix the server URLs in your config, then run `opencode mcp list`.",
    }
  }
  return {
    id: "mcp",
    title: "MCP",
    status: "ok",
    summary: `${entries.length} MCP server${entries.length === 1 ? "" : "s"} configured (${local} local, ${remote} remote${disabled ? `, ${disabled} disabled` : ""}${sandboxed ? `, ${sandboxed} sandboxed` : ""}).`,
    details: [...details, "Live connection status: run `opencode mcp list` or open `/status` in the TUI."].slice(0, 10),
    nextAction: "Use `opencode mcp list` if you need to verify live connections.",
  }
}

function browserCheck(): Check {
  return {
    id: "browser",
    title: "Browser",
    status: "skip",
    summary: "No browser automation runtime is available in this build.",
    details: [
      "The MCP browser helper only opens a URL in the operating system browser.",
      "Playwright browser tests are limited to the desktop/app test suite.",
    ],
    nextAction:
      "Use an MCP server or plugin that exposes browser tools if you need automation. Do not expect `browser_*` tools from this runtime.",
  }
}

function lspCheck(config: ConfigV1.Info): Check {
  const value = config.lsp
  if (value === false) {
    return {
      id: "lsp",
      title: "LSP",
      status: "skip",
      summary: "LSP is disabled in configuration.",
      nextAction: "Set `lsp` to `true` or a server map to enable language servers.",
    }
  }
  if (value === undefined || value === true) {
    return {
      id: "lsp",
      title: "LSP",
      status: "ok",
      summary: "Built-in LSP servers are enabled and start on demand.",
      details: ["Use `opencode debug lsp diagnostics <file>` to verify a server for a specific file."],
    }
  }
  const details: string[] = []
  const errors: string[] = []
  let configured = 0
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    const server = entry as Record<string, unknown>
    if (server.disabled === true) {
      details.push(`${id}: disabled`)
      continue
    }
    configured += 1
    const command = Array.isArray(server.command) ? server.command : []
    const bin = typeof command[0] === "string" ? command[0] : undefined
    if (!bin) {
      errors.push(`${id}: no command configured.`)
    } else if (isTemplateUrl(bin)) {
      details.push(`${id}: ${bin} (unresolved template)`)
    } else if (!commandExists(bin)) {
      errors.push(`${id}: command "${bin}" was not found on PATH.`)
    } else {
      details.push(`${id}: ${bin}`)
    }
  }
  if (errors.length) {
    return {
      id: "lsp",
      title: "LSP",
      status: "fail",
      summary: `${errors.length} configured LSP server${errors.length === 1 ? "" : "s"} cannot start.`,
      details: [...errors, ...details].slice(0, 10),
      nextAction: "Install the missing language-server command or fix its `command` in config, then retry.",
    }
  }
  return {
    id: "lsp",
    title: "LSP",
    status: "ok",
    summary: `${configured} custom LSP server${configured === 1 ? "" : "s"} configured.`,
    details: [...details, "Live status is available in the TUI `/status` dialog."].slice(0, 10),
    nextAction: "Use `opencode debug lsp diagnostics <file>` to verify a server.",
  }
}

function gitCheck(directory: string): Check {
  const git = which("git")
  if (!git) {
    return {
      id: "git",
      title: "Git",
      status: "fail",
      summary: "Git is not installed or is not on PATH.",
      nextAction: "Install Git and run `opencode doctor` again. Git-backed worktrees and the git tool require it.",
    }
  }
  const version = execute(["git", "--version"], directory)
  if (!version.ok) {
    return {
      id: "git",
      title: "Git",
      status: "fail",
      summary: "Git exists but could not be executed.",
      details: [version.error],
      nextAction: "Check that the `git` binary is executable and that PATH is correct.",
    }
  }
  const inside = execute(["git", "rev-parse", "--is-inside-work-tree"], directory)
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      id: "git",
      title: "Git",
      status: "ok",
      summary: `Git is available (${version.stdout.trim()}); the current directory is not inside a repository.`,
      details: ["Git-backed features are optional outside a repository."],
    }
  }
  const root = execute(["git", "rev-parse", "--show-toplevel"], directory)
  const branch = execute(["git", "branch", "--show-current"], directory)
  const status = execute(["git", "status", "--porcelain"], directory)
  const changes = status.ok ? status.stdout.trim().split("\n").filter(Boolean).length : 0
  return {
    id: "git",
    title: "Git",
    status: "ok",
    summary: `Git is available (${version.stdout.trim()}) and the directory is inside a repository.`,
    details: [
      root.ok && root.stdout.trim() ? `root: ${root.stdout.trim()}` : undefined,
      branch.ok && branch.stdout.trim() ? `branch: ${branch.stdout.trim()}` : undefined,
      `working tree: ${changes ? `${changes} changed file${changes === 1 ? "" : "s"}` : "clean"}`,
    ].filter((item): item is string => Boolean(item)),
  }
}

function permissionCheck(config: ConfigV1.Info): Check {
  const permission: unknown = config.permission
  if (!permission) {
    return {
      id: "permissions",
      title: "Permissions",
      status: "ok",
      summary: "No explicit permission overrides; built-in defaults apply.",
      nextAction: "Use `permission` in config if you need to restrict edits, bash, or external directories.",
    }
  }
  const rules: Array<{ key: string; action: string; pattern?: string }> = []
  if (typeof permission === "string") {
    rules.push({ key: "*", action: permission })
  } else if (isRecord(permission)) {
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        rules.push({ key, action: value })
        continue
      }
      if (!isRecord(value)) continue
      for (const [pattern, action] of Object.entries(value)) {
        if (typeof action === "string") rules.push({ key, pattern, action })
      }
    }
  }
  const broad = rules.filter(
    (rule) =>
      rule.action === "allow" &&
      (rule.key === "*" ||
        rule.pattern === "*" ||
        (!rule.pattern && ["edit", "bash", "external_directory"].includes(rule.key))),
  )
  const details = rules
    .slice(0, 10)
    .map((rule) => `${rule.key}${rule.pattern ? `[${rule.pattern}]` : ""}: ${rule.action}`)
  if (broad.length) {
    return {
      id: "permissions",
      title: "Permissions",
      status: "warn",
      summary: `${broad.length} broad allow rule${broad.length === 1 ? "" : "s"} detected.`,
      details: [...details, "Broad allow rules reduce the protection of edits, shell commands, or external paths."],
      nextAction: "Review `permission` in your config and replace broad `allow` rules with narrower patterns.",
    }
  }
  return {
    id: "permissions",
    title: "Permissions",
    status: "ok",
    summary: `${rules.length} permission rule${rules.length === 1 ? "" : "s"} configured.`,
    details,
  }
}

function sandboxCheck(config: ConfigV1.Info): Check {
  const sandboxed = Object.values(config.mcp ?? {}).filter((server) => {
    if (!isRecord(server)) return false
    const value = server as Record<string, unknown>
    return value.type === "local" && value.sandbox === true
  }).length
  return {
    id: "sandbox",
    title: "Sandbox",
    status: "skip",
    summary: sandboxed
      ? `${sandboxed} local MCP server${sandboxed === 1 ? " is" : "s are"} sandboxed; no general sandbox runtime is available.`
      : "No general sandbox runtime is available.",
    details: [
      "MCP local servers can opt into a reduced environment and workspace confinement with `sandbox: true`.",
      "Project worktrees provide change isolation, not a security boundary.",
    ],
    nextAction:
      "Set `sandbox: true` on untrusted local MCP servers. Use worktrees for change isolation, not as a security sandbox.",
  }
}

async function storageCheck(): Promise<Check> {
  const probe = path.join(Global.Path.data, `.doctor-${process.pid}-${Date.now()}`)
  let writable = false
  try {
    await writeFile(probe, "ok")
    await rm(probe, { force: true })
    writable = true
  } catch {}
  if (!writable) {
    return {
      id: "storage",
      title: "Storage",
      status: "fail",
      summary: "The data directory is not writable.",
      details: [`data: ${Global.Path.data}`],
      nextAction: "Check filesystem permissions and free space for the data directory, then retry.",
    }
  }
  const db = Database.path()
  let size: number | undefined
  if (db !== ":memory:") {
    try {
      size = Number((await stat(db)).size)
    } catch {}
  }
  return {
    id: "storage",
    title: "Storage",
    status: "ok",
    summary: "The data directory is writable and the database path is available.",
    details: [
      `data: ${Global.Path.data}`,
      `state: ${Global.Path.state}`,
      `cache: ${Global.Path.cache}`,
      `database: ${db}${size !== undefined ? ` (${formatBytes(size)})` : " (will be created on first run)"}`,
    ],
  }
}

function dependencyCheck(): Check {
  const checks = ["bun", "node", "git", "rg"].map((name) => `${name}: ${which(name) ?? "not found"}`)
  const missing = ["git", "rg"].filter((name) => !which(name))
  return {
    id: "dependencies",
    title: "Dependencies",
    status: missing.length ? "warn" : "ok",
    summary: missing.length
      ? `Missing optional/required binaries: ${missing.join(", ")}.`
      : `Runtime: Bun ${process.versions.bun ?? "unknown"}; Node ${process.version}; ${os.type()} ${os.release()} ${os.arch()}.`,
    details: [
      `opencode: ${InstallationVersion} (${InstallationLocal ? "local build" : InstallationChannel})`,
      `bun: ${process.versions.bun ?? "unknown"}`,
      `node: ${process.version}`,
      ...checks,
    ],
    nextAction: missing.length
      ? "Install the missing binaries or run `opencode debug ripgrep` to resolve the bundled ripgrep path."
      : undefined,
  }
}

function configuredProviders(config: ConfigV1.Info, catalog: Catalog, credentials: Credentials) {
  const result = new Set<string>()
  for (const id of Object.keys(config.provider ?? {})) result.add(id)
  for (const id of Object.keys(credentials)) result.add(id)
  for (const [id, provider] of Object.entries(catalog)) {
    if (provider.env.some((name) => Boolean(process.env[name]))) result.add(id)
  }
  for (const id of config.enabled_providers ?? []) result.add(id)
  return result
}

function providerMap(config: ConfigV1.Info, catalog: Catalog) {
  const result: Record<string, { name: string; api?: string; env: string[]; models: Record<string, unknown> }> = {}
  for (const [id, provider] of Object.entries(catalog)) {
    result[id] = {
      name: provider.name,
      api: provider.api,
      env: [...provider.env],
      models: provider.models,
    }
  }
  for (const [id, provider] of Object.entries(config.provider ?? {})) {
    const base = result[id]
    const models = { ...(base?.models ?? {}), ...(provider.models ?? {}) }
    result[id] = {
      name: provider.name ?? base?.name ?? id,
      api: provider.api ?? stringOption(provider.options?.baseURL) ?? base?.api,
      env: provider.env ?? base?.env ?? [],
      models,
    }
  }
  return result
}

function isConnected(
  id: string,
  provider: { env: string[]; models: Record<string, unknown> },
  config: ConfigV1.Info,
  credentials: Credentials,
) {
  if (credentials[id]) return true
  if (config.provider?.[id]?.options?.apiKey) return true
  if (provider.env.some((name) => Boolean(process.env[name]))) return true
  return false
}

function providerEnv(id: string, provider: { env: string[] }, config: ConfigV1.Info) {
  return config.provider?.[id]?.env ?? provider.env
}

function stringOption(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function splitModel(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function isTemplateUrl(value: string) {
  return value.includes("${") || value.includes("{env:")
}

function displayUrl(value: string) {
  if (isTemplateUrl(value)) return value
  try {
    const url = new URL(value)
    if (url.username) url.username = "***"
    if (url.password) url.password = "***"
    if (url.search) url.search = "?***"
    url.hash = ""
    return url.toString()
  } catch {
    return value.replace(/([?&][^=&#]+)=[^&#]*/g, "$1=***")
  }
}

function commandExists(command: string) {
  if (path.isAbsolute(command) || command.startsWith(".")) {
    return existsSync(command)
  }
  return Boolean(which(command))
}

function execute(command: string[], cwd: string) {
  try {
    const result = Bun.spawnSync({
      cmd: command,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    return {
      ok: result.exitCode === 0,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      error: new TextDecoder().decode(result.stderr).trim() || `exit code ${result.exitCode}`,
    }
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", error: errorMessage(error) }
  }
}

function gitRoot(directory: string) {
  if (!which("git")) return undefined
  const result = execute(["git", "rev-parse", "--show-toplevel"], directory)
  return result.ok && result.stdout.trim() ? result.stdout.trim() : undefined
}

function formatConfigFailure(error: unknown) {
  const name = isRecord(error) ? error.name : undefined
  if (name === "ConfigJsonError") return "Invalid JSON(C) syntax."
  const formatted = FormatError(error) ?? errorMessage(error)
  const input = formatted.indexOf("--- JSONC Input ---")
  const summary = input === -1 ? formatted : formatted.slice(0, input).trim()
  return summary.length > 800 ? `${summary.slice(0, 800)}...` : summary
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

export * as Doctor from "."
