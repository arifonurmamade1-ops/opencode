import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  envUsername: process.env.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = original.envUsername
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the opencode username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })

  test("rejects invalid or missing credentials without leaking comparisons", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("wrong") }, config)).toBe(false)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("") }, config)).toBe(false)
    expect(
      ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, { password: Option.none(), username: "alice" }),
    ).toBe(false)
    expect(
      ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, { password: Option.some(""), username: "alice" }),
    ).toBe(false)
  })

  test("reports whether authentication is configured from the environment", () => {
    delete process.env.OPENCODE_SERVER_PASSWORD
    expect(ServerAuth.configured()).toBe(false)

    process.env.OPENCODE_SERVER_PASSWORD = ""
    expect(ServerAuth.configured()).toBe(false)

    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    expect(ServerAuth.configured()).toBe(true)
  })

  test("builds the pairing token from credentials", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.authToken()).toBe(Buffer.from("alice:secret").toString("base64"))
    expect(ServerAuth.authToken({ username: "bob", password: "cli-secret" })).toBe(
      Buffer.from("bob:cli-secret").toString("base64"),
    )
    expect(ServerAuth.header()).toBe(`Basic ${ServerAuth.authToken()}`)
  })
})
