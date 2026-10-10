export * as Google from "./google"

import { Effect, Option, Schema } from "effect"

export interface Deps {
  readonly fetch: typeof globalThis.fetch
  readonly url: string
  readonly key: string
}

const InlinePart = Schema.Struct({
  inlineData: Schema.Struct({ mimeType: Schema.String, data: Schema.String }),
})
const TextPart = Schema.Struct({ text: Schema.String })
const SpeakResponse = Schema.Struct({
  candidates: Schema.Array(Schema.Struct({ content: Schema.Struct({ parts: Schema.Array(InlinePart) }) })),
})
const TranscriptionResponse = Schema.Struct({
  candidates: Schema.Array(Schema.Struct({ content: Schema.Struct({ parts: Schema.Array(TextPart) }) })),
})

const generate = Effect.fn("Google.generate")(function* (deps: Deps, model: string, body: unknown) {
  const response = yield* Effect.tryPromise({
    try: () =>
      deps.fetch(`${deps.url}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": deps.key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    catch: () => "request failed",
  })
  if (!response.ok) return yield* Effect.fail(`http ${response.status}`)
  return yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => "invalid response",
  })
})

export const speak = Effect.fn("Google.speak")(function* (deps: Deps, model: string, voice: string, text: string) {
  const body = yield* generate(deps, model, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["TEXT_TO_SPEECH"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  })
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(SpeakResponse)(body))
  const part = decoded?.candidates[0]?.content.parts[0]
  if (!part) return yield* Effect.fail("invalid response")
  return {
    data: new Uint8Array(Buffer.from(part.inlineData.data, "base64")),
    mime: part.inlineData.mimeType,
  }
})

export const transcribe = Effect.fn("Google.transcribe")(function* (
  deps: Deps,
  model: string,
  input: { readonly data: Uint8Array; readonly mime: string; readonly language?: string },
) {
  const prompt = input.language
    ? `Transcribe this audio to text. Language: ${input.language}. Respond with only the transcription.`
    : "Transcribe this audio to text. Respond with only the transcription."
  const body = yield* generate(deps, model, {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: input.mime, data: Buffer.from(input.data).toString("base64") } },
          { text: prompt },
        ],
      },
    ],
  })
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(TranscriptionResponse)(body))
  const text = decoded?.candidates[0]?.content.parts[0]?.text
  if (text === undefined) return yield* Effect.fail("invalid response")
  return text.trim()
})
