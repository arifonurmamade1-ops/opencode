import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { externalIPs, resolveNetworkOptions, withNetworkOptions } from "../network"
import { ServerAuth } from "@/server/auth"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    const token = ServerAuth.authToken()
    if (!token) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    } else if (!Server.isLoopbackHostname(server.hostname)) {
      const hosts = server.hostname === "0.0.0.0" || server.hostname === "::" ? externalIPs() : [server.hostname]
      if (hosts.length > 0) {
        console.log("authenticated remote access:")
        for (const host of hosts) console.log(`  http://${host}:${server.port}/?auth_token=${token}`)
        console.log("Pairing links embed the server credentials; treat them like the password.")
      }
    }

    yield* Effect.never
  }),
})
