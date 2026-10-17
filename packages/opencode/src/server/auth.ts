export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createHash, timingSafeEqual } from "node:crypto"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

// Compare digests so both the length and the byte values of secrets stay
// indistinguishable to callers. Never short-circuit credential checks.
function constantTimeEquals(left: string, right: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest()
  return timingSafeEqual(digest(left), digest(right))
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  if (!Option.isSome(config.password) || config.password.value === "") return false
  const username = constantTimeEquals(credentials.username, config.username)
  const password = constantTimeEquals(Redacted.value(credentials.password), config.password.value)
  return username && password
}

// True when the current process environment configures authentication. This is
// the same source the `Config` service reads, so callers can gate exposure
// decisions on the exact credentials the middleware will enforce.
export function configured() {
  return process.env["OPENCODE_SERVER_PASSWORD"] !== undefined && process.env["OPENCODE_SERVER_PASSWORD"] !== ""
}

export function authToken(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return Buffer.from(`${username}:${password}`).toString("base64")
}

export function header(credentials?: Credentials) {
  const token = authToken(credentials)
  if (!token) return undefined
  return `Basic ${token}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
