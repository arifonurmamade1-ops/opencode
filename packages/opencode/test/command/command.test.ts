import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const EDIT_COMMANDS = ["explain", "fix", "refactor", "tests", "docs", "generate"] as const

const mcpLayer = Layer.mock(MCP.Service, { prompts: () => Effect.succeed({}) })
const skillLayer = Layer.mock(Skill.Service, { all: () => Effect.succeed([]) })

const compile = (config: Layer.Layer<Config.Service>, skill: Layer.Layer<Skill.Service>) =>
  LayerNode.compile(Command.node, [
    [Config.node, config],
    [MCP.node, mcpLayer],
    [Skill.node, skill],
  ])

const it = testEffect(compile(TestConfig.layer(), skillLayer))

const withUserCommand = testEffect(
  compile(
    TestConfig.layer({
      get: () =>
        Effect.succeed({
          command: { explain: { description: "team explain", template: "explain $1 for the team" } },
        }),
    }),
    skillLayer,
  ),
)

const withSkills = testEffect(
  compile(
    TestConfig.layer(),
    Layer.mock(Skill.Service, {
      all: () =>
        Effect.succeed([
          { name: "explain", description: "skill description", location: "<built-in>", content: "skill body" },
          { name: "my-skill", description: "skill description", location: "<built-in>", content: "skill body" },
        ]),
    }),
  ),
)

describe("command.hints", () => {
  test("collects numbered placeholders in order without duplicates", () => {
    expect(Command.hints("use $1 then $2 then $1 again")).toEqual(["$1", "$2"])
  })

  test("sorts numbered placeholders and appends $ARGUMENTS last", () => {
    expect(Command.hints("$2 $ARGUMENTS $1")).toEqual(["$1", "$2", "$ARGUMENTS"])
  })

  test("returns no hints for a static template", () => {
    expect(Command.hints("no placeholders here")).toEqual([])
  })
})

describe("command", () => {
  it.instance("registers the built-in editing commands with argument hints", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const list = yield* command.list()

      expect(list.map((item) => item.name)).toEqual(expect.arrayContaining(["init", "review", ...EDIT_COMMANDS]))

      for (const name of EDIT_COMMANDS) {
        const info = yield* command.get(name)
        expect(info?.source).toBe("command")
        expect(info?.subtask).toBeUndefined()
        expect(info?.hints).toEqual(["$ARGUMENTS"])
        expect(typeof info?.description).toBe("string")
        expect(typeof info?.template).toBe("string")
        expect(String(info?.template)).toContain("Input: $ARGUMENTS")
      }
    }),
  )

  it.instance("keeps review as a subtask command", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const review = yield* command.get("review")

      expect(review?.subtask).toBe(true)
      expect(review?.hints).toEqual(["$ARGUMENTS"])
    }),
  )

  withUserCommand.instance("lets a user command override a built-in command", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const info = yield* command.get("explain")

      expect(info?.description).toBe("team explain")
      expect(info?.hints).toEqual(["$1"])
      expect(String(info?.template)).toBe("explain $1 for the team")
    }),
  )

  withSkills.instance("keeps built-ins over same-named skills and registers other skills", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const builtin = yield* command.get("explain")
      const skill = yield* command.get("my-skill")

      expect(builtin?.source).toBe("command")
      expect(skill?.source).toBe("skill")
    }),
  )
})
