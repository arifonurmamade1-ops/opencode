import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Browser } from "@/browser"
import { testEffect } from "./lib/effect"

const layer = LayerNode.compile(Browser.node)
const it = testEffect(layer)

describe("browser", () => {
  it.instance(
    "opens a page and reads title/text",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const page = yield* browser.newPage("main", "about:blank")
        expect(page).toBe("main")
        yield* browser.evaluate(page, "document.title = 'Hello Browser'")
        expect(yield* browser.title(page)).toBe("Hello Browser")
        const text = yield* browser.text(page)
        expect(typeof text).toBe("string")
        yield* browser.closeAll()
      }),
    240_000,
  )

  it.instance(
    "click and fill interactions work",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const page = yield* browser.newPage("interact")
        yield* browser.navigate(
          page,
          "data:text/html,<input id=in value=old><button id=b onclick=\"document.getElementById('out').textContent='clicked'\">Go</button><span id=out></span>",
        )
        yield* browser.fill(page, "#in", "new value")
        yield* browser.click(page, "#b")
        const filled = yield* browser.evaluate(page, "document.querySelector('#in').value")
        expect(filled).toBe("\"new value\"")
        expect(yield* browser.text(page, "#out")).toBe("clicked")
        yield* browser.closeAll()
      }),
    240_000,
  )

  it.instance(
    "screenshot writes a file",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const page = yield* browser.newPage("shot", "about:blank")
        const file = yield* browser.screenshot(page, `${process.cwd()}/browser-test.png`)
        expect(file.endsWith("browser-test.png")).toBe(true)
        const exists = yield* Effect.promise(() => Bun.file(file).exists())
        expect(exists).toBe(true)
        yield* browser.closePage(page)
        yield* Effect.promise(() => Bun.write(file, ""))
      }),
    240_000,
  )
})
