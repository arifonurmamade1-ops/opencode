import { Location } from "@opencode-ai/schema/location"
import { Voice } from "@opencode-ai/schema/voice"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { VoiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const VoiceGroup = HttpApiGroup.make("server.voice")
  .add(
    HttpApiEndpoint.post("voice.transcribe", "/api/voice/transcribe", {
      query: LocationQuery,
      payload: Voice.TranscribeInput,
      success: Location.response(Voice.TranscribeOutput),
      error: VoiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.voice.transcribe",
          summary: "Transcribe speech",
          description:
            "Transcribe base64-encoded audio through the configured voice fallback chain. Falls back to the client's Web Speech API when unavailable.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("voice.speak", "/api/voice/speak", {
      query: LocationQuery,
      payload: Voice.SpeakInput,
      success: Location.response(Voice.SpeakOutput),
      error: VoiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.voice.speak",
          summary: "Synthesize speech",
          description:
            "Synthesize base64-encoded audio for text through the configured voice fallback chain. Falls back to the client's Web Speech API when unavailable.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "voice", description: "Optional voice interface routes." }))
