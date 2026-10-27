import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import path from "path"
import { Browser } from "@/browser"
import { Agent } from "../../src/agent/agent"
import { BrowserTool } from "../../src/tool/browser"
import { Truncate } from "../../src/tool/truncate"
import { Tool } from "../../src/tool/tool"
import { MessageID, SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = Layer.mergeAll(
  LayerNode.compile(CrossSpawnSpawner.node),
  Layer.mock(Browser.Service, {
    screenshot: (_id, filePath) => Effect.succeed(filePath ?? ""),
  }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
  }),
  Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "primary",
        permission: [],
        options: {},
      } satisfies Agent.Info),
  }),
)
const it = testEffect(layer)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-browser-tool"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

type Ask = Parameters<Tool.Context["ask"]>[0]

function recordingContext() {
  const asked: Ask[] = []
  return {
    asked,
    ctx: {
      ...ctx,
      ask: (input: Ask) => Effect.sync(() => void asked.push(input)),
    },
  }
}

const init = Effect.fn("BrowserToolTest.init")(function* () {
  const info = yield* BrowserTool
  return yield* info.init()
})

const run = Effect.fn("BrowserToolTest.run")(function* (
  args: Tool.InferParameters<typeof BrowserTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.browser", () => {
  it.instance("resolves relative screenshot paths and asks for edit permission", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const record = recordingContext()
      const target = path.join(test.directory, "shots", "home.png")

      const result = yield* run({ action: "screenshot", page: "main", path: "shots/home.png" }, record.ctx)

      expect(result.output).toContain(target)
      expect(record.asked.map((request) => request.permission)).toEqual(["edit"])
      expect(record.asked[0]?.metadata).toEqual({ filepath: target })
    }),
  )

  it.instance("asks for external directory access before writing a screenshot outside the project", () =>
    Effect.gen(function* () {
      const outside = yield* tmpdirScoped()
      const record = recordingContext()
      const target = path.join(outside, "outside.png")

      yield* run({ action: "screenshot", page: "main", path: target }, record.ctx)

      expect(record.asked.map((request) => request.permission)).toEqual(["external_directory", "edit"])
      expect(record.asked[0]?.metadata).toEqual({ filepath: target, parentDir: outside })
    }),
  )

  it.instance("defaults screenshots into .opencode/screenshots", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const record = recordingContext()

      const result = yield* run({ action: "screenshot", page: "main" }, record.ctx)

      expect(result.output).toContain(path.join(test.directory, ".opencode", "screenshots", "browser-"))
      expect(record.asked.map((request) => request.permission)).toEqual(["edit"])
    }),
  )
})
