import { Voice } from "@opencode-ai/core/voice"
import { VoiceUnavailableError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const VoiceHandler = HttpApiBuilder.group(Api, "server.voice", (handlers) =>
  handlers
    .handle(
      "voice.transcribe",
      Effect.fn(function* (ctx) {
        const voice = yield* Voice.Service
        const result = yield* voice
          .transcribe({
            data: new Uint8Array(Buffer.from(ctx.payload.data, "base64")),
            mime: ctx.payload.mime,
            language: ctx.payload.language,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new VoiceUnavailableError({
                  message: "Speech recognition is unavailable",
                  attempts: error.attempts.map((attempt) => ({ provider: attempt.provider, reason: attempt.reason })),
                }),
            ),
          )
        return yield* response(Effect.succeed({ text: result.text, provider: result.provider }))
      }),
    )
    .handle(
      "voice.speak",
      Effect.fn(function* (ctx) {
        const voice = yield* Voice.Service
        const result = yield* voice.speak({ text: ctx.payload.text, voice: ctx.payload.voice }).pipe(
          Effect.mapError(
            (error) =>
              new VoiceUnavailableError({
                message: "Speech synthesis is unavailable",
                attempts: error.attempts.map((attempt) => ({ provider: attempt.provider, reason: attempt.reason })),
              }),
          ),
        )
        return yield* response(
          Effect.succeed({
            data: Buffer.from(result.data).toString("base64"),
            mime: result.mime,
            provider: result.provider,
          }),
        )
      }),
    ),
)
