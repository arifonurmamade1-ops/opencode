export * as Voice from "./voice"

import { Schema } from "effect"
import { optional } from "./schema"

export interface TranscribeInput extends Schema.Schema.Type<typeof TranscribeInput> {}
export const TranscribeInput = Schema.Struct({
  data: Schema.String.annotate({ description: "Base64-encoded audio bytes" }),
  mime: Schema.String.annotate({ description: "Audio mime type, e.g. audio/webm" }),
  language: optional(Schema.String.annotate({ description: "Optional language hint for transcription" })),
}).annotate({ identifier: "Voice.TranscribeInput" })

export interface TranscribeOutput extends Schema.Schema.Type<typeof TranscribeOutput> {}
export const TranscribeOutput = Schema.Struct({
  text: Schema.String.annotate({ description: "Transcribed speech" }),
  provider: Schema.String.annotate({ description: "Voice provider that produced the transcript" }),
}).annotate({ identifier: "Voice.TranscribeOutput" })

export interface SpeakInput extends Schema.Schema.Type<typeof SpeakInput> {}
export const SpeakInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Text to synthesize into speech" }),
  voice: optional(Schema.String.annotate({ description: "Optional voice name understood by the provider" })),
}).annotate({ identifier: "Voice.SpeakInput" })

export interface SpeakOutput extends Schema.Schema.Type<typeof SpeakOutput> {}
export const SpeakOutput = Schema.Struct({
  data: Schema.String.annotate({ description: "Base64-encoded audio bytes" }),
  mime: Schema.String.annotate({ description: "Mime type of the produced audio" }),
  provider: Schema.String.annotate({ description: "Voice provider that produced the audio" }),
}).annotate({ identifier: "Voice.SpeakOutput" })
