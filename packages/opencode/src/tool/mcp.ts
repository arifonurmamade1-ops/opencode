import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import DESCRIPTION from "./mcp.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  server: Schema.optional(Schema.String).annotate({
    description: "MCP server to inspect in detail. Defaults to listing every configured server.",
  }),
})

type Metadata = {
  servers: number
  connected: number
  tools: number
  problems: number
}

export const McpStatusTool = Tool.define<typeof Parameters, Metadata, Config.Service | MCP.Service>(
  "mcp",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const status = yield* mcp.status()
          // List tools first so rate limiters are materialized for servers that
          // have not been exercised yet.
          const tools = yield* mcp.tools()
          const stats = yield* mcp.stats()

          const entries = new Map(Object.entries(cfg.mcp ?? {}))
          const problems = [...entries]
            .filter(([, entry]) => !MCP.isMcpConfigured(entry))
            .map(([name]) => `${name}: entry needs a "type" of "local" or "remote"`)
          const names = [...new Set([...entries.keys(), ...Object.keys(status), ...Object.keys(stats)])].sort()

          const byServer = new Map<string, string[]>()
          for (const tool of Object.values(tools)) {
            byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), tool.def.name])
          }

          const metadata: Metadata = {
            servers: names.length,
            connected: names.filter((name) => status[name]?.status === "connected").length,
            tools: Object.keys(tools).length,
            problems: problems.length,
          }

          if (params.server !== undefined) {
            if (!names.includes(params.server)) {
              return {
                title: `Unknown MCP server ${params.server}`,
                output: `No MCP server named "${params.server}".\n\nKnown servers: ${names.join(", ") || "none"}.`,
                metadata,
              }
            }
            return {
              title: `MCP server ${params.server}`,
              output: describe(params.server, {
                status: status[params.server],
                stats: stats[params.server],
                entry: entries.get(params.server),
                tools: byServer.get(params.server) ?? [],
                detail: true,
              }).join("\n"),
              metadata,
            }
          }

          const lines = names.flatMap((name) =>
            describe(name, {
              status: status[name],
              stats: stats[name],
              entry: entries.get(name),
              tools: byServer.get(name) ?? [],
              detail: false,
            }),
          )
          if (problems.length > 0) lines.push("Problems:", ...problems.map((problem) => `- ${problem}`), "")

          return {
            title: `${names.length} MCP server(s), ${metadata.connected} connected`,
            output: lines.length > 0 ? lines.join("\n").trimEnd() : "No MCP servers configured.",
            metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function describe(
  name: string,
  input: {
    status?: MCP.Status
    stats?: MCP.ServerStats
    entry?: unknown
    tools: string[]
    detail: boolean
  },
): string[] {
  const lines = [`${name}: ${statusText(input.status)}`]
  if (MCP.isMcpConfigured(input.entry)) {
    const entry = input.entry
    const parts = [`type ${entry.type}`]
    if (entry.timeout !== undefined) parts.push(`timeout ${entry.timeout}ms`)
    if (entry.retry) {
      parts.push(`retry ${entry.retry.attempts ?? 1} attempt(s) with ${entry.retry.delay ?? 250}ms delay`)
    }
    if (entry.rateLimit) parts.push(`rate limit ${entry.rateLimit.requests} per ${entry.rateLimit.window}ms`)
    if (entry.trusted) parts.push("trusted")
    if (entry.type === "local" && entry.sandbox) parts.push("sandboxed")
    lines.push(`  ${parts.join(" · ")}`)
    const permissions = Object.keys(entry.permission ?? {}).length
    if (permissions > 0) lines.push(`  permission rules: ${permissions}`)
  }
  if (input.tools.length > 0) {
    const names = input.detail ? input.tools.join(", ") : input.tools.slice(0, 5).join(", ")
    const rest = !input.detail && input.tools.length > 5 ? `, +${input.tools.length - 5} more` : ""
    lines.push(`  tools: ${input.tools.length} (${names}${rest})`)
  }
  if (input.stats) {
    const window = input.stats.rateLimit
    lines.push(
      `  calls: ${input.stats.calls} (${input.stats.succeeded} ok, ${input.stats.failed} failed, ${input.stats.retries} retried, ${input.stats.rateLimited} rate limited)` +
        (window ? ` · window usage: ${window.used}/${window.requests}` : ""),
    )
    lines.push(`  connects: ${input.stats.connects} ok, ${input.stats.connectFailures} failed`)
  }
  lines.push("")
  return lines
}

function statusText(status?: MCP.Status) {
  if (!status) return "not connected"
  if (status.status === "failed") return `failed — ${status.error}`
  if (status.status === "needs_client_registration") return `needs client registration — ${status.error}`
  return status.status.replaceAll("_", " ")
}
