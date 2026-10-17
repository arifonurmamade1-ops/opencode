import { Effect, Layer } from "effect"
import { Storage } from "@/storage/storage"

/**
 * In-memory Storage layer for scheduler tests so nothing touches the real
 * global data directory. Reset between tests through `reset`.
 */
export function memoryStorage() {
  const files = new Map<string, unknown>()
  const key = (parts: string[]) => parts.join("/")
  const missing = (parts: string[]) => new Storage.NotFoundError({ message: key(parts) })
  const layer = Layer.succeed(
    Storage.Service,
    Storage.Service.of({
      read: <T>(target: string[]) =>
        Effect.gen(function* () {
          const value = files.get(key(target))
          if (value === undefined) return yield* missing(target)
          return structuredClone(value) as T
        }),
      write: <T>(target: string[], content: T) =>
        Effect.sync(() => {
          files.set(key(target), structuredClone(content))
        }),
      update: <T>(target: string[], fn: (draft: T) => void) =>
        Effect.gen(function* () {
          const value = files.get(key(target))
          if (value === undefined) return yield* missing(target)
          const draft = structuredClone(value) as T
          fn(draft)
          files.set(key(target), draft)
          return draft
        }),
      remove: (target: string[]) =>
        Effect.sync(() => {
          files.delete(key(target))
        }),
      list: (prefix: string[]) =>
        Effect.sync(() =>
          [...files.keys()].filter((entry) => entry.startsWith(key(prefix))).map((entry) => entry.split("/")),
        ),
    }),
  )
  return { layer, reset: () => files.clear() }
}
