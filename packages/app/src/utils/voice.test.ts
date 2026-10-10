import { describe, expect, test } from "bun:test"
import {
  speakWithFallback,
  transcribeWithFallback,
  webSpeechRecognize,
  webSpeechSpeak,
  type RecognitionConstructor,
  type RecognitionEventLike,
  type RecognitionLike,
  type SynthesisLike,
  type VoiceServer,
} from "./voice"

const recognition = (transcript: string): RecognitionConstructor => {
  class FakeRecognition implements RecognitionLike {
    continuous = false
    interimResults = false
    lang = ""
    onresult: ((event: RecognitionEventLike) => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    onend: (() => void) | null = null
    start() {
      this.onresult?.({ resultIndex: 0, results: { 0: { 0: { transcript }, isFinal: true } } })
      this.onend?.()
    }
    stop() {}
  }
  return FakeRecognition
}

const healthy = (overrides?: Partial<VoiceServer["voice"]>): VoiceServer => ({
  voice: {
    transcribe: async () => ({ text: "server text", provider: "groq" }),
    speak: async () => ({ data: Buffer.from([1, 2, 3, 4]).toString("base64"), mime: "audio/mpeg", provider: "google" }),
    ...overrides,
  },
})

const down: VoiceServer = {
  voice: {
    transcribe: async () => {
      throw new Error("voice unavailable")
    },
    speak: async () => {
      throw new Error("voice unavailable")
    },
  },
}

describe("voice facade", () => {
  test("transcribes through the server when the chain is healthy", async () => {
    const result = await transcribeWithFallback(healthy(), { data: "AAAA", mime: "audio/webm", language: "pt" })
    expect(result).toEqual({ text: "server text", source: "server", provider: "groq" })
  })

  test("falls back to Web Speech recognition when the server fails", async () => {
    const result = await transcribeWithFallback(down, { data: "AAAA", mime: "audio/webm" }, recognition("hello"))
    expect(result).toEqual({ text: "hello", source: "web-speech" })
  })

  test("rethrows the server error when Web Speech is disabled", async () => {
    await expect(transcribeWithFallback(down, { data: "AAAA", mime: "audio/webm" }, null)).rejects.toThrow(
      "voice unavailable",
    )
  })

  test("plays server audio through the play hook", async () => {
    const played: { data: Uint8Array; mime: string }[] = []
    const result = await speakWithFallback(healthy(), { text: "hi" }, { play: (data, mime) => played.push({ data, mime }) })
    expect(result).toEqual({ source: "server", provider: "google" })
    expect(played).toHaveLength(1)
    expect(Array.from(played[0]!.data)).toEqual([1, 2, 3, 4])
    expect(played[0]!.mime).toBe("audio/mpeg")
  })

  test("falls back to speech synthesis when the server fails", async () => {
    const spoken: string[] = []
    const synthesis: SynthesisLike = { speak: (utterance) => spoken.push(utterance.text) }
    const result = await speakWithFallback(down, { text: "fallback text" }, { synthesis })
    expect(result).toEqual({ source: "web-speech" })
    expect(spoken).toEqual(["fallback text"])
  })

  test("web speech recognition resolves transcribed text", async () => {
    await expect(webSpeechRecognize({ recognition: recognition("spoken") })).resolves.toBe("spoken")
  })

  test("web speech synthesis speaks an utterance", async () => {
    const spoken: string[] = []
    webSpeechSpeak("say this", { synthesis: { speak: (utterance) => spoken.push(utterance.text) } })
    expect(spoken).toEqual(["say this"])
  })
})
