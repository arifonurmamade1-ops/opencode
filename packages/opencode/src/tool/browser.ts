import { Effect, Schema } from "effect"
import path from "path"
import * as Tool from "./tool"
import { Browser } from "@/browser"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "new_page",
    "navigate",
    "click",
    "fill",
    "text",
    "title",
    "evaluate",
    "screenshot",
    "pages",
    "close_page",
    "close_all",
  ]).annotate({ description: "Browser action to perform" }),
  url: Schema.optional(Schema.String).annotate({ description: "URL to open or navigate to" }),
  page: Schema.optional(Schema.String).annotate({ description: "Page id. Defaults to 'main'." }),
  selector: Schema.optional(Schema.String).annotate({ description: "CSS selector to target" }),
  text: Schema.optional(Schema.String).annotate({ description: "Text to fill/type" }),
  script: Schema.optional(Schema.String).annotate({ description: "JavaScript evaluated in the page" }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "Screenshot output path. Relative paths resolve against the project directory. Defaults to .opencode/screenshots.",
  }),
})

const DEFAULT_PAGE = "main"

export const BrowserTool = Tool.define(
  "browser",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description:
        "Drive a real browser with Playwright. Supports opening pages, navigating, clicking, filling, reading text, evaluating JS, screenshots and closing pages. Use carefully; browser state is shared per instance.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const pageId = params.page && params.page.trim() !== "" ? params.page : DEFAULT_PAGE

          switch (params.action) {
            case "new_page": {
              const id = yield* browser.newPage(pageId, params.url)
              return {
                title: "page created",
                output: `Created page: ${id}${params.url ? ` -> ${params.url}` : ""}`,
                metadata: {},
              }
            }
            case "navigate": {
              if (!params.url) throw new Error("navigate requires 'url'")
              const currentTitle = yield* browser.navigate(pageId, params.url)
              return {
                title: currentTitle,
                output: `Navigated to ${params.url} (title: "${currentTitle}")`,
                metadata: {},
              }
            }
            case "click": {
              if (!params.selector) throw new Error("click requires 'selector'")
              yield* browser.click(pageId, params.selector)
              return { title: "clicked", output: `Clicked ${params.selector}`, metadata: {} }
            }
            case "fill": {
              if (!params.selector) throw new Error("fill requires 'selector'")
              if (params.text === undefined) throw new Error("fill requires 'text'")
              yield* browser.fill(pageId, params.selector, params.text)
              return { title: "filled", output: `Filled ${params.selector}`, metadata: {} }
            }
            case "text": {
              const value = yield* browser.text(pageId, params.selector)
              const trimmed = value.length > 100_000 ? `${value.slice(0, 100_000)}...` : value
              return {
                title: "text",
                output: trimmed,
                metadata: {},
              }
            }
            case "title": {
              const t = yield* browser.title(pageId)
              return { title: t, output: t, metadata: {} }
            }
            case "evaluate": {
              if (!params.script) throw new Error("evaluate requires 'script'")
              const result = yield* browser.evaluate(pageId, params.script)
              return { title: "result", output: result, metadata: {} }
            }
            case "screenshot": {
              const instance = yield* InstanceState.context
              const target = screenshotPath(instance.directory, params.path)
              yield* assertExternalDirectoryEffect(ctx, target)
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, target)],
                always: ["*"],
                metadata: { filepath: target },
              })
              const saved = yield* browser.screenshot(pageId, target)
              return {
                title: "screenshot",
                output: `Saved screenshot to ${saved}`,
                metadata: {},
              }
            }
            case "pages": {
              const list = yield* browser.pages()
              return {
                title: "pages",
                output: list.length === 0 ? "No pages open" : list.map((id) => `- ${id}`).join("\n"),
                metadata: {},
              }
            }
            case "close_page": {
              yield* browser.closePage(pageId)
              return { title: "closed", output: `Closed page: ${pageId}`, metadata: {} }
            }
            case "close_all": {
              yield* browser.closeAll()
              return { title: "closed all", output: "All pages closed", metadata: {} }
            }
            default:
              throw new Error("Unsupported browser action")
          }
        }).pipe(Effect.orDie),
      formatValidationError(error) {
        return String(error)
      },
    }
  }),
)

function screenshotPath(directory: string, input?: string) {
  const requested = input?.trim()
  if (!requested) return path.join(directory, ".opencode", "screenshots", `browser-${Date.now()}.png`)
  return path.isAbsolute(requested) ? requested : path.join(directory, requested)
}
