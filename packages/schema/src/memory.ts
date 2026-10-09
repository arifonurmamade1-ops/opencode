export * as Memory from "./memory"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { ProjectID } from "./project-id"
import { statics } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("Memory.ID"),
  statics((schema) => ({ create: () => schema.make("mem_" + ascending()) })),
)
export type ID = typeof ID.Type

/**
 * Persistence scope: PROJECT_MEMORY, AGENT_MEMORY, TASK_MEMORY or
 * SESSION_MEMORY. Project rows are shared across the project; the other scopes
 * anchor to a `subject` (agent id, task id or session id).
 */
export const Scope = Schema.Literals(["project", "agent", "task", "session"])
export type Scope = typeof Scope.Type

/** Only durable, useful knowledge categories are stored. */
export const Kind = Schema.Literals([
  "architecture",
  "decision",
  "rule",
  "convention",
  "bug",
  "command",
  "config",
  "user_decision",
  "result",
])
export type Kind = typeof Kind.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  scope: Scope,
  kind: Kind,
  subject: Schema.String,
  key: Schema.String,
  content: Schema.String,
}).annotate({ identifier: "Memory.Info" })
