import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Memory } from "@opencode-ai/schema/memory"
import { Timestamps } from "../database/schema.sql"
import { ProjectSchema } from "../project/schema"
import { ProjectTable } from "../project/sql"

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().$type<Memory.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    scope: text().$type<Memory.Scope>().notNull(),
    kind: text().$type<Memory.Kind>().notNull(),
    // Empty string instead of NULL so project-scoped rows participate in the
    // unique upsert index below (SQLite treats NULLs as distinct).
    subject: text().notNull(),
    key: text().notNull(),
    content: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_project_scope_subject_key_idx").on(
      table.project_id,
      table.scope,
      table.subject,
      table.key,
    ),
  ],
)
