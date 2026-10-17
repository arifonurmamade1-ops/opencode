import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { externalIPs, resolveNetworkOptions, withNetworkOptions } from "../network"
import { ServerAuth } from "@/server/auth"
import { openUrl } from "@opencode-ai/core/open"

function authUrl(base: string, token: string | undefined) {
  if (!token) return base
  const result = new URL(base)
  result.searchParams.set("auth_token", token)
  return result.toString()
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    const token = ServerAuth.authToken()
    if (!token) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = authUrl(`http://localhost:${server.port}`, token)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      for (const ip of externalIPs()) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
          UI.Style.TEXT_NORMAL,
          authUrl(`http://${ip}:${server.port}`, token),
        )
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      openUrl(localhostUrl).catch(() => {})
    } else {
      const displayUrl = authUrl(server.url.toString(), token)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      openUrl(displayUrl).catch(() => {})
    }

    yield* Effect.never
  }),
})
