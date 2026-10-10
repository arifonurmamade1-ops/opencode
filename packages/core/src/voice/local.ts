export * as Local from "./local"

import { Effect } from "effect"

const run = (command: ReadonlyArray<string>, input: Uint8Array | string) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      // Bun exposes a FileSink (write/end), not a web WritableStream, for piped stdin.
      proc.stdin.write(input instanceof Uint8Array ? input : new TextEncoder().encode(input))
      proc.stdin.end()
      const [stdout] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited])
      return { exitCode: proc.exitCode, data: new Uint8Array(stdout) }
    },
    catch: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.toLowerCase().includes("enoent") ? "spawn enoent" : message
    },
  }).pipe(
    Effect.flatMap(({ exitCode, data }) => (exitCode === 0 ? Effect.succeed(data) : Effect.fail(`exit ${exitCode}`))),
  )

export const transcribe = (command: ReadonlyArray<string>, data: Uint8Array) =>
  run(command, data).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes).trim()))

export const speak = (command: ReadonlyArray<string>, text: string, mime: string) =>
  run(command, text).pipe(Effect.map((data) => ({ data, mime })))
