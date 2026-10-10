export * as Voice from "./voice"

import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { ConfigVoice } from "./config/voice"
import { makeLocationNode } from "./effect/app-node"
import { Google } from "./voice/google"
import { Groq } from "./voice/groq"
import { Local } from "./voice/local"

export interface TranscribeInput {
  readonly data: Uint8Array
  readonly mime: string
  readonly language?: string
}

export interface SpeakInput {
  readonly text: string
  readonly voice?: string
}

export interface TranscribeOutput {
  readonly text: string
  readonly provider: string
}

export interface SpeakOutput {
  readonly data: Uint8Array
  readonly mime: string
  readonly provider: string
}

export interface Attempt {
  readonly provider: string
  readonly reason: string
}

/**
 * Raised when the whole configured fallback chain is exhausted (or voice is
 * disabled). Clients treat this as the signal to fall back to the browser's
 * Web Speech API.
 */
export class VoiceError extends Schema.TaggedErrorClass<VoiceError>()("Voice.VoiceError", {
  attempts: Schema.Array(Schema.Struct({ provider: Schema.String, reason: Schema.String })),
}) {}

export interface Interface {
  /** Transcribes speech, walking the configured stt fallback chain in order. */
  readonly transcribe: (input: TranscribeInput) => Effect.Effect<TranscribeOutput, VoiceError>
  /** Synthesizes speech, walking the configured tts fallback chain in order. */
  readonly speak: (input: SpeakInput) => Effect.Effect<SpeakOutput, VoiceError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Voice") {}

export interface Deps {
  readonly config: Config.Interface
  readonly fetch?: typeof globalThis.fetch
}

const DEFAULT_URL: Readonly<Record<string, string>> = {
  groq: "https://api.groq.com",
  google: "https://generativelanguage.googleapis.com",
}

const DEFAULT_ENV: Readonly<Record<string, ReadonlyArray<string>>> = {
  groq: ["GROQ_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
}

// Free-first default chain (FASE 16): groq offers the strongest standing free
// STT tier, google the most reliable free-tier TTS. Local is opt-in because no
// canonical binary can be assumed.
const DEFAULT_STT: ReadonlyArray<ConfigVoice.Provider> = [
  new ConfigVoice.Provider({ kind: "groq" }),
  new ConfigVoice.Provider({ kind: "google" }),
]
const DEFAULT_TTS: ReadonlyArray<ConfigVoice.Provider> = [
  new ConfigVoice.Provider({ kind: "google" }),
  new ConfigVoice.Provider({ kind: "groq" }),
]

const resolveKey = (provider: ConfigVoice.Provider) => {
  for (const name of provider.env ?? DEFAULT_ENV[provider.kind] ?? []) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

export const make = (deps: Deps): Interface => {
  const fetch = deps.fetch ?? globalThis.fetch

  const section = Effect.fn("Voice.section")(function* () {
    const info = Config.latest(yield* deps.config.entries(), "voice")
    if (info?.enabled === false) return undefined
    return { stt: info?.stt ?? DEFAULT_STT, tts: info?.tts ?? DEFAULT_TTS }
  })

  const attemptStt = (provider: ConfigVoice.Provider, input: TranscribeInput) => {
    if (provider.kind === "local") {
      if (!provider.command) return Effect.fail("missing command")
      return Local.transcribe(provider.command, input.data)
    }
    const key = resolveKey(provider)
    if (!key) return Effect.fail("missing api key")
    if (provider.kind === "groq")
      return Groq.transcribe(
        { fetch, url: provider.url ?? DEFAULT_URL.groq, key },
        provider.model ?? "whisper-large-v3-turbo",
        input,
      )
    return Google.transcribe(
      { fetch, url: provider.url ?? DEFAULT_URL.google, key },
      provider.model ?? "gemini-2.5-flash",
      input,
    )
  }

  const attemptSpeak = (provider: ConfigVoice.Provider, input: SpeakInput) => {
    if (provider.kind === "local") {
      if (!provider.command) return Effect.fail("missing command")
      return Local.speak(provider.command, input.text, provider.mime ?? "audio/mpeg")
    }
    const key = resolveKey(provider)
    if (!key) return Effect.fail("missing api key")
    if (provider.kind === "groq")
      return Groq.speak(
        { fetch, url: provider.url ?? DEFAULT_URL.groq, key },
        provider.model ?? "playai-tts",
        input.voice ?? provider.voice ?? "Ariston-Classic",
        input.text,
      )
    return Google.speak(
      { fetch, url: provider.url ?? DEFAULT_URL.google, key },
      provider.model ?? "gemini-2.5-flash-preview-tts",
      input.voice ?? provider.voice ?? "Kore",
      input.text,
    )
  }

  const fallback = <A>(
    providers: ReadonlyArray<ConfigVoice.Provider>,
    attempt: (provider: ConfigVoice.Provider) => Effect.Effect<A, string>,
  ) =>
    Effect.gen(function* () {
      const attempts: Attempt[] = []
      for (const provider of providers) {
        const outcome = yield* attempt(provider).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((reason) => Effect.succeed({ ok: false as const, reason })),
        )
        if (outcome.ok) return { value: outcome.value, provider: provider.kind }
        attempts.push({ provider: provider.kind, reason: outcome.reason })
      }
      return yield* Effect.fail(new VoiceError({ attempts }))
    })

  const transcribe = Effect.fn("Voice.transcribe")(function* (input: TranscribeInput) {
    const chain = yield* section()
    if (!chain)
      return yield* Effect.fail(new VoiceError({ attempts: [{ provider: "config", reason: "voice is disabled" }] }))
    const result = yield* fallback(chain.stt, (provider) => attemptStt(provider, input))
    return { text: result.value, provider: result.provider }
  })

  const speak = Effect.fn("Voice.speak")(function* (input: SpeakInput) {
    const chain = yield* section()
    if (!chain)
      return yield* Effect.fail(new VoiceError({ attempts: [{ provider: "config", reason: "voice is disabled" }] }))
    const result = yield* fallback(chain.tts, (provider) => attemptSpeak(provider, input))
    return { ...result.value, provider: result.provider }
  })

  return { transcribe, speak }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    return Service.of(make({ config }))
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
