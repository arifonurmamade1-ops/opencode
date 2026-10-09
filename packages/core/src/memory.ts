export * as Memory from "./memory"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Memory } from "@opencode-ai/schema/memory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { ProjectSchema } from "./project/schema"
import { MemoryTable } from "./memory/sql"

export const ID = Memory.ID
export type ID = Memory.ID

export const Scope = Memory.Scope
export type Scope = Memory.Scope

export const Kind = Memory.Kind
export type Kind = Memory.Kind

export const Info = Memory.Info
export type Info = Memory.Info

export interface ListInput {
  readonly projectID: ProjectSchema.ID
  readonly scope?: Scope
  readonly subject?: string
}

export interface SaveInput {
  readonly projectID: ProjectSchema.ID
  readonly scope: Scope
  readonly kind: Kind
  readonly key: string
  readonly content: string
  readonly subject?: string
}

export interface RemoveInput {
  readonly projectID: ProjectSchema.ID
  readonly id: ID
}

export interface Interface {
  /** Lists memories for a project, optionally narrowed by scope and subject. */
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  /**
   * Saves a memory under a stable `key`. Saving the same
   * (project, scope, subject, key) again updates the existing entry instead of
   * duplicating it, so agents can refine memories in place.
   */
  readonly save: (input: SaveInput) => Effect.Effect<Info>
  /** Removes one memory. Project-scoped: ids from other projects are ignored. */
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Memory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const toInfo = (row: typeof MemoryTable.$inferSelect): Info => ({
      id: row.id,
      projectID: row.project_id,
      scope: row.scope,
      kind: row.kind,
      subject: row.subject,
      key: row.key,
      content: row.content,
    })

    const list = Effect.fn("Memory.list")(function* (input: ListInput) {
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.project_id, input.projectID),
            input.scope ? eq(MemoryTable.scope, input.scope) : undefined,
            input.subject === undefined ? undefined : eq(MemoryTable.subject, input.subject),
          ),
        )
        .orderBy(asc(MemoryTable.scope), asc(MemoryTable.kind), asc(MemoryTable.key))
        .all()
        .pipe(Effect.orDie)
      return rows.map(toInfo)
    })

    const save = Effect.fn("Memory.save")(function* (input: SaveInput) {
      const now = Date.now()
      const row = yield* db
        .insert(MemoryTable)
        .values({
          id: ID.create(),
          project_id: input.projectID,
          scope: input.scope,
          kind: input.kind,
          subject: input.subject ?? "",
          key: input.key,
          content: input.content,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: [MemoryTable.project_id, MemoryTable.scope, MemoryTable.subject, MemoryTable.key],
          set: { kind: input.kind, content: input.content, time_updated: now },
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row === undefined) return yield* Effect.die("Memory.save: upsert returned no row")
      return toInfo(row)
    })

    const remove = Effect.fn("Memory.remove")(function* (input: RemoveInput) {
      return (
        (yield* db
          .delete(MemoryTable)
          .where(and(eq(MemoryTable.id, input.id), eq(MemoryTable.project_id, input.projectID)))
          .returning({ id: MemoryTable.id })
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    return Service.of({ list, save, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
