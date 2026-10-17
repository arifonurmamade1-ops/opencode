import { describe, expect, test } from "bun:test"
import { inlineEditText, INLINE_EDIT_COMMANDS } from "./inline-edit"

describe("inline edit", () => {
  test("emits the bare slash command without a target", () => {
    expect(inlineEditText("explain")).toBe("/explain")
    expect(inlineEditText("generate", {})).toBe("/generate")
  })

  test("references the active file", () => {
    expect(inlineEditText("fix", { path: "src/session.ts" })).toBe("/fix src/session.ts")
  })

  test("references the selected line range", () => {
    expect(inlineEditText("refactor", { path: "src/session.ts", selection: { startLine: 10, endLine: 20 } })).toBe(
      "/refactor src/session.ts:10-20",
    )
  })

  test("treats a null selection as no selection", () => {
    expect(inlineEditText("tests", { path: "src/session.ts", selection: null })).toBe("/tests src/session.ts")
  })

  test("advertises every editing command with a translatable label", () => {
    expect(INLINE_EDIT_COMMANDS.map((item) => item.action)).toEqual([
      "explain",
      "fix",
      "refactor",
      "tests",
      "docs",
      "generate",
    ])
    expect(
      INLINE_EDIT_COMMANDS.every(
        (item) =>
          item.title === `command.inline.${item.action}` &&
          item.description === `command.inline.${item.action}.description`,
      ),
    ).toBe(true)
  })
})
