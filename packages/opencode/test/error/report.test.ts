import { describe, expect, test } from "bun:test"
import { ErrorReport } from "@/error/report"

const labels = ["WHAT:", "WHY:", "WHERE:", "ATTEMPTED:", "RESULT:", "NEXT ACTION:"]

describe("error transparency report", () => {
  test("renders every required field for an unknown error", () => {
    const text = ErrorReport.format(new Error("connection refused while contacting the provider"), {
      where: "opencode run",
      attempted: ["Connect to the provider", "Send the request"],
      result: "No response was received.",
    })

    for (const label of labels) expect(text).toContain(label)
    expect(text).toContain("WHAT: Unable to reach the remote service")
    expect(text).toContain("connection refused while contacting the provider")
    expect(text).toContain("WHERE: opencode run")
    expect(text).toContain("ATTEMPTED: Connect to the provider; Send the request")
    expect(text).toContain("RESULT: No response was received.")
    expect(text).toContain("NEXT ACTION:")
    expect(text).not.toContain("Something went wrong")
  })

  test("keeps provider model failures actionable", () => {
    const text = ErrorReport.format(
      { name: "ProviderModelNotFoundError", data: { providerID: "anthropic", modelID: "missing" } },
      { detail: "Model not found: anthropic/missing" },
    )

    expect(text).toContain("WHAT: Provider model not found")
    expect(text).toContain("WHY: Model not found: anthropic/missing")
    expect(text).toContain("`opencode models`")
  })

  test("keeps configuration failures actionable", () => {
    const text = ErrorReport.format(
      { name: "ConfigJsonError", data: { path: "/tmp/opencode.jsonc" } },
      { detail: "Config file at /tmp/opencode.jsonc is not valid JSON" },
    )

    expect(text).toContain("WHAT: Configuration error")
    expect(text).toContain("opencode debug config")
  })

  test("classifies timeouts and permission failures", () => {
    const timeout = ErrorReport.format(new Error("request timed out after 30000ms"))
    expect(timeout).toContain("WHAT: Operation timed out")
    expect(timeout.toLowerCase()).toContain("retry")

    const permission = ErrorReport.format(new Error("permission denied for path /root/secret"))
    expect(permission).toContain("WHAT: Permission denied")
    expect(permission).toContain("Grant the required permission")
  })

  test("preserves multiline reasons", () => {
    const text = ErrorReport.format(new Error("outer failure"), {
      detail: "outer failure\nCaused by: inner failure",
    })

    expect(text).toContain("WHY: outer failure\n  Caused by: inner failure")
  })

  test("uses explicit context overrides", () => {
    const report = ErrorReport.from(new Error("boom"), {
      what: "Delivery failed",
      where: "tool autonomous_task",
      attempted: "Write the artifact",
      result: "The artifact was not written.",
      nextAction: "Fix the filesystem and retry.",
    })

    expect(report).toEqual({
      what: "Delivery failed",
      why: "boom",
      where: "tool autonomous_task",
      attempted: "Write the artifact",
      result: "The artifact was not written.",
      nextAction: "Fix the filesystem and retry.",
    })
  })

  test("does not turn built-in error names into vague titles", () => {
    const text = ErrorReport.format(new TypeError("x is not a function"))
    expect(text).toContain("WHAT: Operation failed")
    expect(text).toContain("WHY: x is not a function")
  })

  test("never falls back to a generic message for an empty object", () => {
    const text = ErrorReport.format({}, { where: "opencode" })

    expect(text).not.toContain("[object Object]")
    expect(text).toContain("WHY:")
    expect(text).toContain("NEXT ACTION:")
  })
})
