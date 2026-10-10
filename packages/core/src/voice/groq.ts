export * as Groq from "./groq"

import { Effect, Option, Schema } from "effect"

export interface Deps {
  readonly fetch: typeof globalThis.fetch
  readonly url: string
  readonly key: string
}

const Transcription = Schema.Struct({ text: Schema.String })

export const transcribe = Effect.fn("Groq.transcribe")(function* (
  deps: Deps,
  model: string,
  input: { readonly data: Uint8Array; readonly mime: string },
) {
  const form = new FormData()
  form.set("file", new Blob([input.data.slice()], { type: input.mime }), "audio")
  form.set("model", model)
  form.set("response_format", "json")
  const response = yield* Effect.tryPromise({
    try: () =>
      deps.fetch(`${deps.url}/openai/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${deps.key}` },
        body: form,
      }),
    catch: () => "request failed",
  })
  if (!response.ok) return yield* Effect.fail(`http ${response.status}`)
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => "invalid response",
  })
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Transcription)(body))
  if (!decoded) return yield* Effect.fail("invalid response")
  return decoded.text.trim()
})

export const speak = Effect.fn("Groq.speak")(function* (deps: Deps, model: string, voice: string, text: string) {
  const response = yield* Effect.tryPromise({
    try: () =>
      deps.fetch(`${deps.url}/openai/v1/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${deps.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, voice, input: text }),
      }),
    catch: () => "request failed",
  })
  if (!response.ok) return yield* Effect.fail(`http ${response.status}`)
  const audio = yield* Effect.tryPromise({
    try: () => response.arrayBuffer(),
    catch: () => "invalid response",
  })
  return { data: new Uint8Array(audio), mime: "audio/mpeg" }
})
