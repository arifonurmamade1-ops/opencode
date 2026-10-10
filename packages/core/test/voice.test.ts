import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigVoice } from "@opencode-ai/core/config/voice"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Voice } from "@opencode-ai/core/voice"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const AUDIO = new Uint8Array([1, 2, 3, 4])

const stub = (voice?: ConfigVoice.Info): Config.Interface => ({
  entries: () =>
    Effect.succeed(
      voice
        ? [
            new Config.Document({
              type: "document",
              path: AbsolutePath.make("/project/opencode.json"),
              info: new Config.Info({ voice }),
            }),
          ]
        : [],
    ),
})

const router = (routes: Record<string, () => Response>) => {
  const requests: { url: string; init?: RequestInit }[] = []
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    return Promise.resolve(route ? route[1]() : new Response("not found", { status: 404 }))
  }) as typeof globalThis.fetch
  return { requests, fetch }
}

const transcription = (text: string) => Response.json({ text })
const geminiText = (text: string) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] })

describe("Voice", () => {
  it.effect("falls back from a failing provider to the next in the chain", () =>
    Effect.gen(function* () {
      process.env.GROQ_API_KEY = "groq-key"
      process.env.GEMINI_API_KEY = "gemini-key"
      const { requests, fetch } = router({
        "https://api.groq.com": () => new Response("denied", { status: 401 }),
        "https://generativelanguage.googleapis.com": () => geminiText("hello world"),
      })
      const service = Voice.make({
        config: stub(new ConfigVoice.Info({ stt: [new ConfigVoice.Provider({ kind: "groq" }), new ConfigVoice.Provider({ kind: "google" })] })),
        fetch,
      })

      const result = yield* service.transcribe({ data: AUDIO, mime: "audio/webm" })

      expect(result).toEqual({ text: "hello world", provider: "google" })
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.groq.com/openai/v1/audio/transcriptions",
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      ])
    }),
  )

  it.effect("reports every attempt when the whole chain fails", () =>
    Effect.gen(function* () {
      process.env.GROQ_API_KEY = "groq-key"
      process.env.GEMINI_API_KEY = "gemini-key"
      const { fetch } = router({ "": () => new Response("denied", { status: 401 }) })
      const service = Voice.make({
        config: stub(new ConfigVoice.Info({ stt: [new ConfigVoice.Provider({ kind: "groq" }), new ConfigVoice.Provider({ kind: "google" })] })),
        fetch,
      })

      const error = yield* service.transcribe({ data: AUDIO, mime: "audio/webm" }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(Voice.VoiceError)
      expect(error.attempts).toEqual([
        { provider: "groq", reason: "http 401" },
        { provider: "google", reason: "http 401" },
      ])
    }),
  )

  it.effect("skips providers without an api key", () =>
    Effect.gen(function* () {
      delete process.env.GROQ_API_KEY
      process.env.GEMINI_API_KEY = "gemini-key"
      const { requests, fetch } = router({
        "https://api.groq.com": () => transcription("never"),
        "https://generativelanguage.googleapis.com": () => geminiText("from google"),
      })
      const service = Voice.make({
        config: stub(new ConfigVoice.Info({ stt: [new ConfigVoice.Provider({ kind: "groq" }), new ConfigVoice.Provider({ kind: "google" })] })),
        fetch,
      })

      const result = yield* service.transcribe({ data: AUDIO, mime: "audio/webm" })
      expect(result).toEqual({ text: "from google", provider: "google" })
      expect(requests).toHaveLength(1)

      const only = Voice.make({
        config: stub(new ConfigVoice.Info({ stt: [new ConfigVoice.Provider({ kind: "groq" })] })),
        fetch,
      })
      const error = yield* only.transcribe({ data: AUDIO, mime: "audio/webm" }).pipe(Effect.flip)
      expect(error.attempts).toEqual([{ provider: "groq", reason: "missing api key" }])
    }),
  )

  it.effect("sends groq transcriptions to the OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      process.env.GROQ_API_KEY = "groq-key"
      const { requests, fetch } = router({
        "https://api.groq.com": () => transcription("transcribed"),
      })
      const service = Voice.make({ config: stub(new ConfigVoice.Info({ stt: [new ConfigVoice.Provider({ kind: "groq" })] })), fetch })

      const result = yield* service.transcribe({ data: AUDIO, mime: "audio/webm" })

      expect(result).toEqual({ text: "transcribed", provider: "groq" })
      const [request] = requests
      expect(request?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions")
      expect((request?.init?.headers as Record<string, string>).Authorization).toBe("Bearer groq-key")
      const form = request?.init?.body
      expect(form).toBeInstanceOf(FormData)
      expect((form as FormData).get("model")).toBe("whisper-large-v3-turbo")
    }),
  )

  it.effect("builds google speech requests and decodes inline audio", () =>
    Effect.gen(function* () {
      process.env.GEMINI_API_KEY = "gemini-key"
      const { requests, fetch } = router({
        "https://generativelanguage.googleapis.com": () =>
          Response.json({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: Buffer.from(AUDIO).toString("base64") } }],
                },
              },
            ],
          }),
      })
      const service = Voice.make({ config: stub(new ConfigVoice.Info({ tts: [new ConfigVoice.Provider({ kind: "google" })] })), fetch })

      const result = yield* service.speak({ text: "hi there" })

      expect(result.provider).toBe("google")
      expect(result.mime).toBe("audio/L16;rate=24000")
      expect(Array.from(result.data)).toEqual([1, 2, 3, 4])
      const [request] = requests
      expect(request?.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
      )
      const body = JSON.parse(String(request?.init?.body))
      expect(body.generationConfig.responseModalities).toEqual(["TEXT_TO_SPEECH"])
      expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore")
    }),
  )

  it.effect("transcribes through a local command", () =>
    Effect.gen(function* () {
      const script = 'process.stdin.resume();process.stdin.on("data",()=>{});process.stdin.on("end",()=>process.stdout.write("local transcript"))'
      const service = Voice.make({
        config: stub(
          new ConfigVoice.Info({
            stt: [new ConfigVoice.Provider({ kind: "local", command: [process.execPath, "-e", script] })],
          }),
        ),
      })

      const result = yield* service.transcribe({ data: AUDIO, mime: "audio/webm" })

      expect(result).toEqual({ text: "local transcript", provider: "local" })
    }),
  )

  it.effect("honors a custom chain order", () =>
    Effect.gen(function* () {
      process.env.GROQ_API_KEY = "groq-key"
      const script = 'process.stdin.resume();process.stdin.on("data",()=>{});process.stdin.on("end",()=>process.stdout.write("first"))'
      const { requests, fetch } = router({ "https://api.groq.com": () => transcription("cloud") })
      const service = Voice.make({
        config: stub(
          new ConfigVoice.Info({
            stt: [
              new ConfigVoice.Provider({ kind: "local", command: [process.execPath, "-e", script] }),
              new ConfigVoice.Provider({ kind: "groq" }),
            ],
          }),
        ),
        fetch,
      })

      const result = yield* service.transcribe({ data: AUDIO, mime: "audio/webm" })

      expect(result).toEqual({ text: "first", provider: "local" })
      expect(requests).toEqual([])
    }),
  )

  it.effect("fails with a disabled error when voice is turned off", () =>
    Effect.gen(function* () {
      const service = Voice.make({ config: stub(new ConfigVoice.Info({ enabled: false })) })

      const error = yield* service.speak({ text: "hi" }).pipe(Effect.flip)

      expect(error.attempts).toEqual([{ provider: "config", reason: "voice is disabled" }])
    }),
  )
})
