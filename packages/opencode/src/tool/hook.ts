import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import { Hook } from "@/hook/hook"
import DESCRIPTION from "./hook.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  stage: Schema.optional(Schema.String).annotate({
    description: "Hook stage to inspect in detail. Defaults to listing every configured stage.",
  }),
})

type Metadata = {
  stages: number
  commands: number
  problems: number
}

export const HookTool = Tool.define<typeof Parameters, Metadata, Config.Service>(
  "hook",
  Effect.gen(function* () {
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const normalized = Hook.normalize((yield* config.get()).hooks)
          if (params.stage !== undefined && !Hook.isStage(params.stage)) {
            return {
              title: `Unknown stage ${params.stage}`,
              output: `No lifecycle hook stage named "${params.stage}".\n\nKnown stages: ${Hook.STAGES.join(", ")}.`,
              metadata: summary(normalized.hooks, normalized.problems),
            }
          }

          const hooks =
            params.stage === undefined
              ? normalized.hooks
              : normalized.hooks[params.stage]
                ? { [params.stage]: normalized.hooks[params.stage] }
                : {}
          return {
            title:
              params.stage === undefined
                ? `${summary(hooks, normalized.problems).stages} hook stage(s) configured`
                : `Hook stage ${params.stage}`,
            output: Hook.format(hooks, normalized.problems),
            metadata: summary(hooks, normalized.problems),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function summary(hooks: Hook.Definitions, problems: readonly string[]): Metadata {
  const stages = Hook.STAGES.filter((stage) => (hooks[stage]?.length ?? 0) > 0)
  return {
    stages: stages.length,
    commands: stages.reduce((total, stage) => total + (hooks[stage]?.length ?? 0), 0),
    problems: problems.length,
  }
}
