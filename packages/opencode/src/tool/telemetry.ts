import { DateTime, Effect, Option, Schema } from "effect"
import { and, desc, inArray, like } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { NotFoundError } from "@/storage/storage"
import { Telemetry } from "@/telemetry/telemetry"
import DESCRIPTION from "./telemetry.txt"
import * as Tool from "./tool"

const MAX_SESSIONS = 500
const MAX_TOP = 50
const DAY_MS = 24 * 60 * 60 * 1000
const EVENT_CHUNK = 400

export const Parameters = Schema.Struct({
  days: Schema.optional(NonNegativeInt).annotate({
    description: "Only include sessions updated within the last N days (0 = today only). Defaults to all time.",
  }),
  all_projects: Schema.optional(Schema.Boolean).annotate({
    description: "Report across every project stored on this machine instead of only the current project.",
  }),
  top: Schema.optional(PositiveInt).annotate({
    description: `Maximum entries per ranked list (models, providers, tools). Defaults to 10, capped at ${MAX_TOP}.`,
  }),
})

type Metadata = {
  enabled: boolean
  sessions: number
  analyzed: number
  turns: number
  failures: number
  retries: number
}

type SessionRow = typeof SessionTable.$inferSelect

export const TelemetryTool = Tool.define<typeof Parameters, Metadata, Config.Service | Database.Service | Session.Service>(
  "telemetry",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const sessions = yield* Session.Service

    const loadRetries = Effect.fnUntraced(function* (ids: readonly string[]) {
      const result = new Map<string, Telemetry.RetryRecord[]>()
      for (const chunk of chunks(ids, EVENT_CHUNK)) {
        const rows = yield* database.db
          .select()
          .from(EventTable)
          .where(and(like(EventTable.type, `${SessionEvent.Retried.type}.%`), inArray(EventTable.aggregate_id, chunk)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(SessionEvent.Retried.data)(row.data))
          if (!decoded) continue
          const list = result.get(row.aggregate_id) ?? []
          list.push({
            attempt: decoded.attempt,
            timestamp: DateTime.toEpochMillis(decoded.timestamp),
            message: decoded.error.message,
            statusCode: decoded.error.statusCode,
            retryable: decoded.error.isRetryable,
          })
          result.set(row.aggregate_id, list)
        }
      }
      return result
    })

    const buildTask = Effect.fnUntraced(function* (row: SessionRow, retries: readonly Telemetry.RetryRecord[]) {
      const info = Session.fromRow(row)
      const messages = yield* sessions
        .messages({ sessionID: info.id })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([] as SessionV1.WithParts[])))
      const turns: Telemetry.Turn[] = []
      let userMessages = 0
      for (const message of messages) {
        if (message.info.role === "user") {
          userMessages++
          continue
        }
        const assistant = message.info
        const tools: Telemetry.ToolCall[] = []
        for (const part of message.parts) {
          if (part.type !== "tool") continue
          tools.push({ tool: part.tool, status: part.state.status, durationMs: timed(part.state) })
        }
        turns.push({
          created: assistant.time.created,
          completed: assistant.time.completed,
          cost: assistant.cost ?? 0,
          tokens: {
            input: assistant.tokens.input,
            output: assistant.tokens.output,
            reasoning: assistant.tokens.reasoning,
            cacheRead: assistant.tokens.cache.read,
            cacheWrite: assistant.tokens.cache.write,
          },
          providerID: assistant.providerID,
          modelID: assistant.modelID,
          agent: assistant.agent,
          errorName: assistant.error?.name,
          retryable:
            assistant.error !== undefined &&
            SessionV1.APIError.isInstance(assistant.error) &&
            assistant.error.data.isRetryable === true,
          tools,
        })
      }
      return {
        id: info.id,
        created: info.time.created,
        updated: info.time.updated,
        userMessages,
        turns,
        retries,
      } satisfies Telemetry.Task
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (cfg.telemetry?.enabled !== true) return disabledResult()

          const ins = yield* InstanceState.context
          const rows = yield* database.db
            .select()
            .from(SessionTable)
            .orderBy(desc(SessionTable.time_updated))
            .all()
            .pipe(Effect.orDie)
          const cutoff =
            params.days === undefined ? 0 : params.days === 0 ? startOfToday() : Date.now() - params.days * DAY_MS
          const scoped = rows.filter(
            (row) => (params.all_projects === true || row.project_id === ins.project.id) && row.time_updated >= cutoff,
          )
          const selected = scoped.slice(0, MAX_SESSIONS)
          const retries = yield* loadRetries(selected.map((row) => row.id))
          const tasks = yield* Effect.forEach(selected, (row) => buildTask(row, retries.get(row.id) ?? []), {
            concurrency: 8,
          })

          const report = Telemetry.summarize(tasks)
          const notes =
            scoped.length > selected.length
              ? `Only the ${MAX_SESSIONS} most recently updated sessions were analyzed (of ${scoped.length} in scope); narrow the window with "days".`
              : undefined
          const output = [Telemetry.format(report, { top: Math.min(params.top ?? 10, MAX_TOP) }), notes]
            .filter((line) => line !== undefined)
            .join("\n\n")

          return {
            title: `${report.sessions} session(s), ${report.turns} turn(s)`,
            output,
            metadata: {
              enabled: true,
              sessions: scoped.length,
              analyzed: report.sessions,
              turns: report.turns,
              failures: report.failures.total,
              retries: report.retries.total,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function disabledResult() {
  return {
    title: "Telemetry disabled",
    output: [
      "Local telemetry is disabled by default for privacy.",
      "",
      "To enable it, add this to opencode.json (project or global config):",
      '  { "telemetry": { "enabled": true } }',
      "",
      "The report only reads this machine's local session database on demand (tokens, cost, latency,",
      "tool calls, failures, retries). Nothing is transmitted anywhere and there is no background",
      "collection. Reports never include prompts, file contents, paths, or titles.",
    ].join("\n"),
    metadata: { enabled: false, sessions: 0, analyzed: 0, turns: 0, failures: 0, retries: 0 },
  }
}

function timed(state: SessionV1.ToolState): number | undefined {
  if (state.status === "completed" || state.status === "error") return Math.max(0, state.time.end - state.time.start)
  return undefined
}

function startOfToday() {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now.getTime()
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}
