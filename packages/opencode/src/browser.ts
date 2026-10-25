import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import type { ChildProcess } from "node:child_process"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

export class BrowserError extends Schema.TaggedErrorClass<BrowserError>()("BrowserError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail
  }
}

export interface Interface {
  readonly newPage: (id?: string, url?: string) => Effect.Effect<string, BrowserError>
  readonly navigate: (id: string, url: string) => Effect.Effect<string, BrowserError>
  readonly click: (id: string, selector: string) => Effect.Effect<void, BrowserError>
  readonly fill: (id: string, selector: string, text: string) => Effect.Effect<void, BrowserError>
  readonly text: (id: string, selector?: string) => Effect.Effect<string, BrowserError>
  readonly title: (id: string) => Effect.Effect<string, BrowserError>
  readonly evaluate: (id: string, script: string) => Effect.Effect<string, BrowserError>
  readonly screenshot: (id: string, filePath?: string) => Effect.Effect<string, BrowserError>
  readonly pages: () => Effect.Effect<string[], BrowserError>
  readonly closePage: (id: string) => Effect.Effect<void, BrowserError>
  readonly closeAll: () => Effect.Effect<void, BrowserError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Browser") {}

const workerPath = fileURLToPath(new URL("./browser-worker.cjs", import.meta.url))

type Bridge = {
  readonly send: (cmd: string, args?: Record<string, any>) => Promise<any>
  readonly close: () => void
}

async function startBridge(): Promise<Bridge> {
  return await new Promise<Bridge>((resolve, reject) => {
    const child: ChildProcess = spawn("node", [workerPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    let stdoutBuffer = ""
    let ready = false

    const finishReady = (port: number) => {
      ready = true
      const base = `http://127.0.0.1:${port}`
      resolve({
        async send(cmd: string, args: Record<string, any> = {}) {
          const response = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cmd, args }),
          })
          const data: any = await response.json()
          if (!response.ok || (data && data.error)) throw new Error(data.error || response.statusText)
          return data.result
        },
        close: () => {
          try {
            child.kill()
          } catch {
            void 0
          }
        },
      })
    }

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk
      if (!ready) {
        const match = stdoutBuffer.match(/READY\s+(\d+)/)
        if (match) finishReady(Number(match[1]))
      }
    })
    child.stderr?.on("data", (chunk: any) => {
      if (process.env.DEBUG_BROWSER) process.stderr.write(`[browser-worker] ${chunk}`)
    })
    child.on("close", (code) => {
      if (!ready) reject(new Error(`browser worker exited before ready (code ${code})`))
    })
    setTimeout(() => {
      if (!ready) {
        try {
          child.kill()
        } catch {
          void 0
        }
        reject(new Error("browser worker did not become ready"))
      }
    }, 30_000)
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<Bridge>((_ctx) =>
      Effect.gen(function* () {
        const bridge = yield* Effect.promise(() => startBridge())
        yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()))
        return bridge
      }),
    )

    const getBridge = Effect.fnUntraced(function* () {
      return yield* InstanceState.get(state)
    })

    const call = Effect.fnUntraced(function* (cmd: string, args?: Record<string, any>) {
      const bridge = yield* getBridge()
      return yield* Effect.tryPromise({
        try: () => bridge.send(cmd, args ?? {}),
        catch: (error) => new BrowserError({ detail: String(error) }),
      })
    })

    const newPage = Effect.fn("Browser.newPage")(function* (id?: string, url?: string) {
      return (yield* call("newPage", { id: id ?? "", url: url ?? "" })) as string
    })
    const navigate = Effect.fn("Browser.navigate")(function* (id: string, url: string) {
      return (yield* call("navigate", { id, url })) as string
    })
    const click = Effect.fn("Browser.click")(function* (id: string, selector: string) {
      yield* call("click", { id, selector })
    })
    const fill = Effect.fn("Browser.fill")(function* (id: string, selector: string, text: string) {
      yield* call("fill", { id, selector, text })
    })
    const text = Effect.fn("Browser.text")(function* (id: string, selector?: string) {
      return (yield* call("text", { id, selector: selector ?? "" })) as string
    })
    const title = Effect.fn("Browser.title")(function* (id: string) {
      return (yield* call("title", { id })) as string
    })
    const evaluate = Effect.fn("Browser.evaluate")(function* (id: string, script: string) {
      return (yield* call("evaluate", { id, script })) as string
    })
    const screenshot = Effect.fn("Browser.screenshot")(function* (id: string, filePath?: string) {
      return (yield* call("screenshot", { id, filePath: filePath ?? "" })) as string
    })
    const pages = Effect.fn("Browser.pages")(function* () {
      return (yield* call("pages", {})) as string[]
    })
    const closePage = Effect.fn("Browser.closePage")(function* (id: string) {
      yield* call("closePage", { id })
    })
    const closeAll = Effect.fn("Browser.closeAll")(function* () {
      yield* call("closeAll", {})
    })

    return Service.of({
      newPage,
      navigate,
      click,
      fill,
      text,
      title,
      evaluate,
      screenshot,
      pages,
      closePage,
      closeAll,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [],
})

export * as Browser from "./browser"
