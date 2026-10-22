import type { Config, LspStatus, McpStatus, Provider, VcsInfo } from "@opencode-ai/sdk/v2"
import { isRecord } from "./util/record"

export type Status = "ok" | "warn" | "fail" | "skip"

export type Check = {
  id: string
  title: string
  status: Status
  summary: string
  nextAction?: string
}

export type Input = {
  connection: "loading" | "partial" | "complete"
  config: Config
  providers: Provider[]
  connected: string[]
  mcp: Record<string, McpStatus>
  lsp: LspStatus[]
  vcs?: VcsInfo
  model?: { providerID: string; modelID: string }
  version: string
}

export function build(input: Input): Check[] {
  const config = configCheck(input)
  if (input.connection !== "complete") {
    return [
      config,
      pending("providers", "Providers"),
      pending("models", "Models"),
      pending("apis", "APIs"),
      pending("mcp", "MCP"),
      pending("browser", "Browser"),
      pending("lsp", "LSP"),
      pending("git", "Git"),
      pending("permissions", "Permissions"),
      pending("sandbox", "Sandbox"),
      pending("storage", "Storage"),
      pending("dependencies", "Dependencies"),
    ]
  }
  return [
    config,
    providerCheck(input),
    modelCheck(input),
    apiCheck(),
    mcpCheck(input),
    browserCheck(),
    lspCheck(input),
    gitCheck(input),
    permissionCheck(input.config),
    sandboxCheck(input.config),
    storageCheck(),
    dependencyCheck(input.version),
  ]
}

function pending(id: string, title: string): Check {
  return {
    id,
    title,
    status: "skip",
    summary: "Waiting for the session to finish loading.",
    nextAction: "Run `/doctor` again after the session finishes loading.",
  }
}

export function render(checks: Check[]) {
  return checks
    .map((check) => {
      const next = check.status !== "ok" && check.nextAction ? `\n  next: ${check.nextAction}` : ""
      return `[${check.status}] ${check.title}: ${check.summary}${next}`
    })
    .join("\n")
}

export function summary(checks: Check[]) {
  const count = (status: Status) => checks.filter((check) => check.status === status).length
  return `${count("ok")} ok, ${count("warn")} warning${count("warn") === 1 ? "" : "s"}, ${count("fail")} failure${count("fail") === 1 ? "" : "s"}, ${count("skip")} skipped`
}

function configCheck(input: Input): Check {
  if (input.connection !== "complete") {
    return {
      id: "config",
      title: "Configuration",
      status: "warn",
      summary: "Server data is still loading; the report may be incomplete.",
      nextAction: "Wait for the session to finish loading, then run `/doctor` again.",
    }
  }
  return {
    id: "config",
    title: "Configuration",
    status: "ok",
    summary: `Loaded (${input.providers.length} providers, ${Object.keys(input.mcp).length} MCP servers).`,
  }
}

function providerCheck(input: Input): Check {
  if (!input.providers.length) {
    return {
      id: "providers",
      title: "Providers",
      status: "fail",
      summary: "No providers are available.",
      nextAction: "Run `opencode auth login` or add a provider to your config, then reload the TUI.",
    }
  }
  const connected = input.connected.filter((id) => input.providers.some((provider) => provider.id === id))
  if (!connected.length) {
    return {
      id: "providers",
      title: "Providers",
      status: "fail",
      summary: `${input.providers.length} provider${input.providers.length === 1 ? "" : "s"} available but none are connected.`,
      nextAction: "Run `opencode auth login` or set the provider's API key environment variable, then reload the TUI.",
    }
  }
  return {
    id: "providers",
    title: "Providers",
    status: "ok",
    summary: `${connected.length} of ${input.providers.length} providers connected.`,
  }
}

function modelCheck(input: Input): Check {
  if (!input.model) {
    return {
      id: "models",
      title: "Models",
      status: "fail",
      summary: "No model is selected for this session.",
      nextAction: "Choose a model with `/models` or set `model` in your config.",
    }
  }
  const provider = input.providers.find((item) => item.id === input.model!.providerID)
  if (!provider) {
    return {
      id: "models",
      title: "Models",
      status: "fail",
      summary: `Provider "${input.model.providerID}" is not available.`,
      nextAction: "Choose another model with `/models` or fix the provider configuration.",
    }
  }
  if (!provider.models[input.model.modelID]) {
    return {
      id: "models",
      title: "Models",
      status: "fail",
      summary: `Model "${input.model.modelID}" is not available for provider "${provider.id}".`,
      nextAction: "Choose a listed model with `/models` or update `model` in your config.",
    }
  }
  return {
    id: "models",
    title: "Models",
    status: "ok",
    summary: `${input.model.providerID}/${input.model.modelID} resolved.`,
  }
}

function apiCheck(): Check {
  return {
    id: "apis",
    title: "APIs",
    status: "skip",
    summary: "API reachability is checked on the server host.",
    nextAction: "Run `opencode doctor --network` on the machine running the server to probe configured endpoints.",
  }
}

function mcpCheck(input: Input): Check {
  const entries = Object.entries(input.mcp)
  if (!entries.length) {
    return {
      id: "mcp",
      title: "MCP",
      status: "ok",
      summary: "No MCP servers are configured.",
    }
  }
  const failed = entries.filter(
    ([, status]) => status.status === "failed" || status.status === "needs_client_registration",
  )
  const needsAuth = entries.filter(([, status]) => status.status === "needs_auth")
  const connected = entries.filter(([, status]) => status.status === "connected")
  if (failed.length) {
    return {
      id: "mcp",
      title: "MCP",
      status: "fail",
      summary: `${failed.length} of ${entries.length} MCP servers failed.`,
      nextAction: `Inspect the errors with \`opencode mcp list\`; fix the server configuration or command, then retry. ${failed
        .map(([name]) => name)
        .join(", ")}`,
    }
  }
  if (needsAuth.length) {
    return {
      id: "mcp",
      title: "MCP",
      status: "warn",
      summary: `${needsAuth.length} of ${entries.length} MCP servers need authentication.`,
      nextAction: `Run \`opencode mcp auth <name>\` for: ${needsAuth.map(([name]) => name).join(", ")}.`,
    }
  }
  return {
    id: "mcp",
    title: "MCP",
    status: "ok",
    summary: `${connected.length} connected, ${entries.length - connected.length} disabled or idle.`,
  }
}

function browserCheck(): Check {
  return {
    id: "browser",
    title: "Browser",
    status: "skip",
    summary: "No browser automation runtime is available in this build.",
    nextAction: "Use an MCP server or plugin that exposes browser tools if you need automation.",
  }
}

function lspCheck(input: Input): Check {
  const failed = input.lsp.filter((status) => status.status === "error")
  if (failed.length) {
    return {
      id: "lsp",
      title: "LSP",
      status: "fail",
      summary: `${failed.length} LSP server${failed.length === 1 ? "" : "s"} reported errors.`,
      nextAction: "Run `opencode debug lsp diagnostics <file>` on the server for details, then check the server command.",
    }
  }
  if (!input.lsp.length) {
    return {
      id: "lsp",
      title: "LSP",
      status: "ok",
      summary: "No LSP server is active yet; servers start on demand.",
      nextAction: "Open a supported source file or run `opencode debug lsp diagnostics <file>` to start one.",
    }
  }
  return {
    id: "lsp",
    title: "LSP",
    status: "ok",
    summary: `${input.lsp.length} LSP server${input.lsp.length === 1 ? "" : "s"} connected.`,
  }
}

function gitCheck(input: Input): Check {
  if (!input.vcs?.branch) {
    return {
      id: "git",
      title: "Git",
      status: "skip",
      summary: "Not a git repository, or VCS information is unavailable.",
      nextAction: "Run `git init` if you want worktrees and git-backed history, or `opencode doctor` for a Git binary check.",
    }
  }
  return {
    id: "git",
    title: "Git",
    status: "ok",
    summary: `Repository on branch ${input.vcs.branch}.`,
  }
}

function permissionCheck(config: Config): Check {
  const permission: unknown = config.permission
  if (!permission) {
    return {
      id: "permissions",
      title: "Permissions",
      status: "ok",
      summary: "No explicit overrides; built-in defaults apply.",
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
  if (broad.length) {
    return {
      id: "permissions",
      title: "Permissions",
      status: "warn",
      summary: `${broad.length} broad allow rule${broad.length === 1 ? "" : "s"} configured.`,
      nextAction: "Review `permission` in your config and replace broad `allow` rules with narrower patterns.",
    }
  }
  return {
    id: "permissions",
    title: "Permissions",
    status: "ok",
    summary: `${rules.length} permission rule${rules.length === 1 ? "" : "s"} configured.`,
  }
}

function sandboxCheck(config: Config): Check {
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
    nextAction: "Set `sandbox: true` on untrusted local MCP servers. Worktrees isolate changes, not security.",
  }
}

function storageCheck(): Check {
  return {
    id: "storage",
    title: "Storage",
    status: "skip",
    summary: "Storage paths and database checks run on the server host.",
    nextAction: "Run `opencode doctor` on the machine running the server to check data directories and the database.",
  }
}

function dependencyCheck(version: string): Check {
  return {
    id: "dependencies",
    title: "Dependencies",
    status: "ok",
    summary: `opencode ${version}, Bun ${process.versions.bun ?? "unknown"}.`,
  }
}
