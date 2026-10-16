import { describe, expect, test } from "bun:test"
import { sessionPanelLayout } from "./session-panel-layout"

describe("sessionPanelLayout", () => {
  test("keeps one V2 owner while changing panel geometry", () => {
    expect(sessionPanelLayout({ review: false, terminal: false, files: false, browser: false })).toEqual({
      visible: false,
      stacked: false,
    })
    expect(sessionPanelLayout({ review: false, terminal: true, files: false, browser: false })).toEqual({
      visible: true,
      stacked: false,
    })
    expect(sessionPanelLayout({ review: true, terminal: true, files: false, browser: false })).toEqual({
      visible: true,
      stacked: true,
    })
  })
  test("browser alone is visible but not stacked", () => {
    expect(sessionPanelLayout({ review: false, terminal: false, files: false, browser: true })).toEqual({
      visible: true,
      stacked: false,
    })
  })
  test("browser stacks under review like the terminal", () => {
    expect(sessionPanelLayout({ review: true, terminal: false, files: false, browser: true })).toEqual({
      visible: true,
      stacked: true,
    })
  })
  test("files alone is visible but not stacked", () => {
    expect(sessionPanelLayout({ review: false, terminal: false, files: true, browser: false })).toEqual({
      visible: true,
      stacked: false,
    })
  })
})
