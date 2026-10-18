import { Effect, Schema } from "effect"
import { Plugin } from "@/plugin"
import { PluginApi } from "@/plugin/api"
import DESCRIPTION from "./plugin.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({
    description: "Plugin id to inspect in detail. Defaults to listing every plugin known to this project.",
  }),
})

type Metadata = {
  total: number
  loaded: number
  skipped: number
  failed: number
}

export const PluginTool = Tool.define<typeof Parameters, Metadata, Plugin.Service>(
  "plugin",
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const records = yield* plugins.inventory()
          const summary = {
            total: records.length,
            loaded: records.filter((record) => record.status === "loaded").length,
            skipped: records.filter((record) => record.status === "skipped").length,
            failed: records.filter((record) => record.status === "failed").length,
          }

          if (params.id === undefined) {
            return {
              title: `${summary.loaded}/${summary.total} plugin(s) loaded`,
              output: PluginApi.format(records),
              metadata: summary,
            }
          }

          const selected = records.filter((record) => record.id === params.id)
          if (!selected.length) {
            const known = records.map((record) => record.id).toSorted()
            return {
              title: `Unknown plugin ${params.id}`,
              output:
                `No plugin with id "${params.id}".` +
                (known.length ? `\n\nKnown ids: ${known.join(", ")}` : "\n\nNo plugins are known to this project."),
              metadata: summary,
            }
          }

          return {
            title: `Plugin ${params.id}`,
            output: PluginApi.format(selected),
            metadata: summary,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
