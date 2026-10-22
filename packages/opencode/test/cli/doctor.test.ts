import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

const ids = [
  "config",
  "providers",
  "models",
  "apis",
  "mcp",
  "browser",
  "lsp",
  "git",
  "permissions",
  "sandbox",
  "storage",
  "dependencies",
]

describe("doctor command", () => {
  cliIt.live("prints an actionable JSON report", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["doctor", "--json"], { timeoutMs: 240_000 })
      opencode.expectExit(result, 0, "doctor")
      const report = JSON.parse(result.stdout)
      expect(report.version).toBeTruthy()
      expect(report.checks.map((check: { id: string }) => check.id)).toEqual(ids)
      expect(report.summary.fail).toBe(0)
      const config = report.checks.find((check: { id: string }) => check.id === "config")
      expect(config.status).toBe("ok")
      const providers = report.checks.find((check: { id: string }) => check.id === "providers")
      expect(providers.status).toBe("ok")
      expect(providers.summary).toContain("credentials")
    }),
    300_000,
  )

  cliIt.live("reports invalid configuration with a next action", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["doctor", "--json"], {
        timeoutMs: 240_000,
        env: { OPENCODE_CONFIG_CONTENT: "{ this is not json" },
      })
      expect(result.exitCode).toBe(1)
      const report = JSON.parse(result.stdout)
      expect(report.summary.fail).toBeGreaterThan(0)
      const config = report.checks.find((check: { id: string }) => check.id === "config")
      expect(config.status).toBe("fail")
      expect(config.nextAction).toContain("Fix the file")
      expect(config.details.join("\n")).toContain("OPENCODE_CONFIG_CONTENT")
    }),
    300_000,
  )
})
