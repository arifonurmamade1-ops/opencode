import { expect, mock, test } from "bun:test"
import { ChildProcess, spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"

await mock.module("@opencode-ai/core/open", () => ({
  openUrl: async (url: string) => {
    const pathname = new URL(url).pathname
    if (pathname === "/launcher-error") {
      // A deterministic stand-in for a launcher that cannot spawn: the runtime
      // may surface spawn failures at spawn() time, which would race the
      // listeners inside open(); the "error" event is delivered on a timer so
      // the test exercises that branch itself.
      const failing = new EventEmitter() as unknown as ChildProcess
      Object.defineProperty(failing, "exitCode", { value: null })
      setTimeout(
        () => failing.emit("error", new Error("spawn opencode-missing-browser-launcher ENOENT")),
        20,
      )
      return failing
    }
    if (pathname === "/launcher-still-alive") {
      // xdg-open style launcher that stays alive through open()'s own grace
      // window, then exits 0 shortly after so nothing lingers behind the test.
      return spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1200)"], { stdio: "ignore" })
    }
    const code = pathname === "/successful" ? 0 : 23
    const subprocess = spawn(process.execPath, ["-e", `process.exit(${code})`], { stdio: "ignore" })
    await once(subprocess, "close")
    return subprocess
  },
}))

const { McpBrowser } = await import("../../src/mcp/browser")

test(
  "reports a browser launcher that exited before openUrl returned",
  async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* McpBrowser.Service
        return yield* Effect.flip(browser.open("https://example.com/authorize"))
      }).pipe(Effect.provide(LayerNode.compile(McpBrowser.node))),
    )

    expect(error.message).toBe("Browser open failed with exit code 23")
  },
  30_000,
)

test(
  "accepts a browser launcher that exited successfully before openUrl returned",
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* McpBrowser.Service
        yield* browser.open("https://example.com/successful")
      }).pipe(Effect.provide(LayerNode.compile(McpBrowser.node))),
    )
  },
  30_000,
)

test(
  "surfaces the launcher's own error when the browser command cannot spawn",
  async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* McpBrowser.Service
        return yield* Effect.flip(browser.open("https://example.com/launcher-error"))
      }).pipe(Effect.provide(LayerNode.compile(McpBrowser.node))),
    )

    // The raw spawn failure is reported, not an exit-code wrapper: nothing
    // ever ran, so there is no exit code.
    expect(error.message).toContain("opencode-missing-browser-launcher")
    expect(error.message).not.toContain("exit code")
  },
  30_000,
)

test(
  "resolves through the grace window when the launcher stays alive",
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* McpBrowser.Service
        yield* browser.open("https://example.com/launcher-still-alive")
      }).pipe(Effect.provide(LayerNode.compile(McpBrowser.node))),
    )
  },
  30_000,
)
