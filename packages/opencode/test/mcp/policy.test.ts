import { describe, expect, test } from "bun:test"
import path from "node:path"
import { McpPolicy } from "@/mcp/policy"

const root = path.parse(process.cwd()).root
const base = path.join(root, "workspace")

describe("McpPolicy.retryPolicy", () => {
  test("defaults to a single attempt", () => {
    expect(McpPolicy.retryPolicy()).toEqual({ attempts: 1, delay: 250 })
    expect(McpPolicy.retryPolicy({})).toEqual({ attempts: 1, delay: 250 })
  })

  test("clamps attempts and delay", () => {
    expect(McpPolicy.retryPolicy({ attempts: 0, delay: -5 })).toEqual({ attempts: 1, delay: 0 })
    expect(McpPolicy.retryPolicy({ attempts: 99.7, delay: 10.9 })).toEqual({ attempts: 10, delay: 10 })
  })
})

describe("McpPolicy.rateLimitPolicy", () => {
  test("requires both requests and window", () => {
    expect(McpPolicy.rateLimitPolicy()).toBeUndefined()
    expect(McpPolicy.rateLimitPolicy({ requests: 1 })).toBeUndefined()
    expect(McpPolicy.rateLimitPolicy({ window: 1000 })).toBeUndefined()
  })

  test("normalizes configured values", () => {
    expect(McpPolicy.rateLimitPolicy({ requests: 5, window: 100 })).toEqual({ requests: 5, window: 100 })
    expect(McpPolicy.rateLimitPolicy({ requests: 0, window: 100 })).toBeUndefined()
  })
})

describe("McpPolicy.withRetry", () => {
  test("retries until the call succeeds", async () => {
    let attempts = 0
    const retries: number[] = []
    const result = await McpPolicy.withRetry(
      async () => {
        attempts += 1
        if (attempts < 3) throw new Error("boom")
        return "ok"
      },
      { attempts: 3, delay: 0 },
      { onRetry: (event) => retries.push(event.attempt) },
    )

    expect(result).toBe("ok")
    expect(attempts).toBe(3)
    expect(retries).toEqual([1, 2])
  })

  test("gives up after the configured attempts", async () => {
    let attempts = 0
    const error = await McpPolicy.withRetry(
      async () => {
        attempts += 1
        throw new Error(`failure ${attempts}`)
      },
      { attempts: 2, delay: 0 },
    ).catch((error: unknown) => error)

    expect(attempts).toBe(2)
    expect((error as Error).message).toBe("failure 2")
  })

  test("never retries tool errors", async () => {
    let attempts = 0
    const error = await McpPolicy.withRetry(
      async () => {
        attempts += 1
        throw new McpPolicy.ToolError("tool failed")
      },
      { attempts: 5, delay: 0 },
    ).catch((error: unknown) => error)

    expect(attempts).toBe(1)
    expect(error).toBeInstanceOf(McpPolicy.ToolError)
  })

  test("never retries rate limits", async () => {
    let attempts = 0
    const error = await McpPolicy.withRetry(
      async () => {
        attempts += 1
        throw new McpPolicy.LimitError(10)
      },
      { attempts: 5, delay: 0 },
    ).catch((error: unknown) => error)

    expect(attempts).toBe(1)
    expect(error).toBeInstanceOf(McpPolicy.LimitError)
    expect((error as McpPolicy.LimitError).retryAfterMs).toBe(10)
  })

  test("waits the configured delay between attempts", async () => {
    const slept: number[] = []
    await McpPolicy.withRetry(
      async () => {
        throw new Error("boom")
      },
      { attempts: 3, delay: 25 },
      {
        sleep: async (ms) => {
          slept.push(ms)
        },
      },
    ).catch(() => {})

    expect(slept).toEqual([25, 25])
  })
})

describe("McpPolicy.Limiter", () => {
  test("allows requests within the window and rejects the rest", () => {
    const limiter = new McpPolicy.Limiter({ requests: 2, window: 1000 })

    expect(limiter.take(0)).toEqual({ ok: true })
    expect(limiter.take(100)).toEqual({ ok: true })
    expect(limiter.take(200)).toEqual({ ok: false, retryAfterMs: 800 })
    expect(limiter.used).toBe(2)
  })

  test("frees capacity as the window slides", () => {
    const limiter = new McpPolicy.Limiter({ requests: 1, window: 1000 })

    expect(limiter.take(0)).toEqual({ ok: true })
    expect(limiter.take(900)).toEqual({ ok: false, retryAfterMs: 100 })
    expect(limiter.take(1000)).toEqual({ ok: true })
    expect(limiter.used).toBe(1)
  })
})

describe("McpPolicy.sandboxEnvironment", () => {
  test("keeps only the allowlisted variables", () => {
    const env = McpPolicy.sandboxEnvironment({
      PATH: "/bin",
      GITHUB_TOKEN: "secret",
      HOME: "/home/me",
      TEMP: "/tmp",
    })

    expect(env.PATH).toBe("/bin")
    expect(env.HOME).toBe("/home/me")
    expect(env.TEMP).toBe("/tmp")
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })

  test("matches allowlisted keys regardless of case", () => {
    const env = McpPolicy.sandboxEnvironment({ Path: "C:\\bin", SystemRoot: "C:\\Windows" })

    expect(env.Path).toBe("C:\\bin")
    expect(env.SystemRoot).toBe("C:\\Windows")
  })

  test("applies the server environment over the inherited set", () => {
    const env = McpPolicy.sandboxEnvironment({ PATH: "/bin" }, { PATH: "/custom", TOKEN: "x" })

    expect(env.PATH).toBe("/custom")
    expect(env.TOKEN).toBe("x")
  })

  test("drops undefined values", () => {
    const env = McpPolicy.sandboxEnvironment({ PATH: undefined, HOME: "/home" })

    expect(Object.keys(env)).toEqual(["HOME"])
  })
})

describe("McpPolicy.sandboxCwd", () => {
  test("defaults to the workspace directory", () => {
    expect(McpPolicy.sandboxCwd(base)).toEqual({ ok: true, path: path.resolve(base) })
  })

  test("allows paths inside the workspace", () => {
    const result = McpPolicy.sandboxCwd(base, path.join("plugins", "sub"))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.path).toBe(path.resolve(base, "plugins", "sub"))
    expect(McpPolicy.sandboxCwd(base, path.join(base, "sub")).ok).toBe(true)
  })

  test("rejects paths outside the workspace", () => {
    for (const cwd of [path.join("..", "outside"), path.join(root, "elsewhere")]) {
      const result = McpPolicy.sandboxCwd(base, cwd)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("inside the workspace")
    }
  })
})
