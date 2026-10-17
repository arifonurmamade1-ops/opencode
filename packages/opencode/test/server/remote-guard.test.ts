import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { withTimeout } from "../../src/util/timeout"

const original = {
  flagPassword: Flag.OPENCODE_SERVER_PASSWORD,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
}

afterEach(() => {
  Flag.OPENCODE_SERVER_PASSWORD = original.flagPassword
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
})

function setPassword(password: string | undefined) {
  if (password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = password
}

describe("Server.listen remote exposure guard", () => {
  test("classifies loopback hostnames", () => {
    expect(Server.isLoopbackHostname("127.0.0.1")).toBe(true)
    expect(Server.isLoopbackHostname("127.8.8.8")).toBe(true)
    expect(Server.isLoopbackHostname("localhost")).toBe(true)
    expect(Server.isLoopbackHostname("LOCALHOST")).toBe(true)
    expect(Server.isLoopbackHostname("::1")).toBe(true)
    expect(Server.isLoopbackHostname("[::1]")).toBe(true)
    expect(Server.isLoopbackHostname("0.0.0.0")).toBe(false)
    expect(Server.isLoopbackHostname("::")).toBe(false)
    expect(Server.isLoopbackHostname("192.168.1.50")).toBe(false)
    expect(Server.isLoopbackHostname("")).toBe(false)
  })

  test("refuses non-loopback hostnames without a password", async () => {
    setPassword(undefined)

    for (const hostname of ["0.0.0.0", "192.168.1.50"]) {
      const cause = await Server.listen({ hostname, port: 0 }).then(
        () => undefined,
        (error: unknown) => error,
      )

      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message).toContain("Refusing to listen")
      expect(message).toContain(hostname)
      expect(message).toContain("OPENCODE_SERVER_PASSWORD")
    }
  })

  test("allows loopback hostnames without a password", async () => {
    setPassword(undefined)

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      expect(listener.port).toBeGreaterThan(0)
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping loopback listener")
    }
  })

  test("allows non-loopback hostnames with a password", async () => {
    setPassword("remote-guard-secret")

    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0 })
    try {
      expect(listener.port).toBeGreaterThan(0)
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping remote listener")
    }
  })
})
