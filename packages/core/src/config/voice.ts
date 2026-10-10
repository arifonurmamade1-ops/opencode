export * as ConfigVoice from "./voice"

import { Schema } from "effect"

export class Provider extends Schema.Class<Provider>("ConfigV2.Voice.Provider")({
  kind: Schema.Literals(["groq", "google", "local"]).annotate({
    description: "Voice provider implementation: groq, google, or a locally spawned command",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Model override. Defaults: whisper-large-v3-turbo (groq stt), gemini-2.5-flash (google stt), gemini-2.5-flash-preview-tts (google tts), playai-tts (groq tts)",
  }),
  voice: Schema.String.pipe(Schema.optional).annotate({
    description: "Text-to-speech voice name, e.g. Kore (gemini) or Ariston-Classic (playai)",
  }),
  url: Schema.String.pipe(Schema.optional).annotate({
    description: "Base URL override for the provider API",
  }),
  env: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description:
      "Environment variables checked in order for the provider API key. Defaults: GROQ_API_KEY (groq), GEMINI_API_KEY then GOOGLE_API_KEY (google)",
  }),
  command: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description:
      "kind local only: argv spawned per request. Speech-to-text writes audio to stdin and reads text from stdout; text-to-speech writes text to stdin and reads audio bytes from stdout",
  }),
  mime: Schema.String.pipe(Schema.optional).annotate({
    description: "kind local text-to-speech only: mime type of produced audio; defaults to audio/mpeg",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Voice")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable the optional voice interface; defaults to true",
  }),
  stt: Schema.Array(Provider).pipe(Schema.optional).annotate({
    description:
      "Ordered speech-to-text fallback chain (Provider A -> Provider B -> ...). Defaults to groq then google",
  }),
  tts: Schema.Array(Provider).pipe(Schema.optional).annotate({
    description:
      "Ordered text-to-speech fallback chain (Provider A -> Provider B -> ...). Defaults to google then groq",
  }),
}) {}
