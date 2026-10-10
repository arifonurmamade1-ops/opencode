/**
 * Optional voice interface for the desktop and browser app.
 *
 * Speech-to-text and text-to-speech first go through the server's voice
 * fallback chain (groq -> google -> local). When the server reports the
 * feature unavailable, the client falls back to the browser's Web Speech API
 * when the platform provides it, matching the FASE 16 fallback order.
 */

export interface VoiceLocation {
  readonly directory?: string
  readonly workspace?: string
}

/** Minimal structural view of the generated voice client used by the facade. */
export interface VoiceServer {
  readonly voice: {
    readonly transcribe: (input: {
      readonly location?: VoiceLocation
      readonly data: string
      readonly mime: string
      readonly language?: string
    }) => Promise<{ readonly text: string; readonly provider: string }>
    readonly speak: (input: {
      readonly location?: VoiceLocation
      readonly text: string
      readonly voice?: string
    }) => Promise<{ readonly data: string; readonly mime: string; readonly provider: string }>
  }
}

export interface RecognitionResultLike {
  readonly transcript: string
}

export interface RecognitionEventLike {
  readonly resultIndex: number
  readonly results: {
    readonly [index: number]: { readonly [item: number]: RecognitionResultLike; readonly isFinal: boolean }
  }
}

export interface RecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: RecognitionEventLike) => void) | null
  onerror: ((event: { readonly error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

export type RecognitionConstructor = new () => RecognitionLike

export interface UtteranceLike {
  text: string
  lang: string
}

export interface SynthesisLike {
  speak(utterance: UtteranceLike): void
}

const utteranceOf = (text: string): UtteranceLike => {
  const Constructor = (
    globalThis as unknown as { SpeechSynthesisUtterance?: new (value: string) => UtteranceLike }
  ).SpeechSynthesisUtterance
  return Constructor ? new Constructor(text) : { text, lang: "" }
}

const recognitionConstructor = () => {
  const globals = globalThis as unknown as {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
  return globals.SpeechRecognition ?? globals.webkitSpeechRecognition
}

export const webSpeechRecognitionAvailable = () => recognitionConstructor() !== undefined

export function webSpeechRecognize(options: { language?: string; recognition?: RecognitionConstructor } = {}) {
  const Constructor = options.recognition ?? recognitionConstructor()
  if (!Constructor) return Promise.reject(new Error("Web Speech recognition is unavailable"))
  return new Promise<string>((resolve, reject) => {
    const recognition = new Constructor()
    recognition.continuous = false
    recognition.interimResults = false
    if (options.language) recognition.lang = options.language
    let transcript = ""
    recognition.onresult = (event) => {
      transcript = event.results[event.resultIndex]?.[0]?.transcript ?? ""
    }
    recognition.onerror = (event) => reject(new Error(`Web Speech recognition failed: ${event.error}`))
    recognition.onend = () => {
      if (transcript) resolve(transcript)
      else reject(new Error("Web Speech recognition produced no result"))
    }
    recognition.start()
  })
}

export function webSpeechSpeak(text: string, options: { language?: string; synthesis?: SynthesisLike } = {}) {
  const synthesis = options.synthesis ?? globalThis.speechSynthesis
  if (!synthesis) throw new Error("Web Speech synthesis is unavailable")
  const utterance = utteranceOf(text)
  if (options.language) utterance.lang = options.language
  synthesis.speak(utterance)
}

const decodeAudio = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

const playAudio = (data: Uint8Array, mime: string) => {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const audio = new Audio(url)
  audio.onended = () => URL.revokeObjectURL(url)
  void audio.play()
}

export interface VoiceTextResult {
  readonly text: string
  readonly source: "server" | "web-speech"
  readonly provider?: string
}

export async function transcribeWithFallback(
  server: VoiceServer,
  input: { location?: VoiceLocation; data: string; mime: string; language?: string },
  recognition?: RecognitionConstructor | null,
): Promise<VoiceTextResult> {
  try {
    const result = await server.voice.transcribe(input)
    return { text: result.text, source: "server", provider: result.provider }
  } catch (error) {
    const Constructor = recognition === null ? undefined : (recognition ?? recognitionConstructor())
    if (!Constructor) throw error
    const text = await webSpeechRecognize({ language: input.language, recognition: Constructor })
    return { text, source: "web-speech" }
  }
}

export async function speakWithFallback(
  server: VoiceServer,
  input: { location?: VoiceLocation; text: string; voice?: string },
  options: { play?: (data: Uint8Array, mime: string) => void; synthesis?: SynthesisLike } = {},
): Promise<{ source: "server" | "web-speech"; provider?: string }> {
  try {
    const result = await server.voice.speak(input)
    ;(options.play ?? playAudio)(decodeAudio(result.data), result.mime)
    return { source: "server", provider: result.provider }
  } catch (error) {
    const synthesis = options.synthesis === undefined ? globalThis.speechSynthesis : options.synthesis
    if (!synthesis) throw error
    webSpeechSpeak(input.text, { synthesis })
    return { source: "web-speech" }
  }
}
