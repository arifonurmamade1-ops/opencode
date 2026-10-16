import { describe, expect, test } from "bun:test"
import {
  back,
  canBack,
  canForward,
  current,
  forward,
  initialBrowserHistory,
  migrate,
  navigate,
  normalizeUrl,
} from "./browser-model"

describe("normalizeUrl", () => {
  test("trims whitespace", () => {
    expect(normalizeUrl("  https://example.com  ")).toBe("https://example.com/")
  })
  test("empty string returns undefined", () => {
    expect(normalizeUrl("")).toBeUndefined()
    expect(normalizeUrl("   ")).toBeUndefined()
  })
  test("adds https scheme for bare host", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/")
    expect(normalizeUrl("example.com:8080")).toBe("https://example.com:8080/")
  })
  test("preserves explicit scheme", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com/")
  })
  test("rejects non-http schemes", () => {
    expect(normalizeUrl("ftp://example.com")).toBeUndefined()
    expect(normalizeUrl("javascript:alert(1)")).toBeUndefined()
  })
  test("rejects invalid urls", () => {
    expect(normalizeUrl("not a url at all")).toBeUndefined()
  })
})

describe("navigate", () => {
  test("pushes a new url onto the stack", () => {
    const next = navigate(initialBrowserHistory, "https://a.com")
    expect(next).toEqual({ stack: ["https://a.com/"], index: 0 })
  })
  test("no-op when url is identical", () => {
    const history = { stack: ["https://a.com/"], index: 0 }
    expect(navigate(history, "https://a.com")).toBe(history)
  })
  test("truncates forward history before pushing", () => {
    const history = { stack: ["https://a.com/", "https://b.com/", "https://c.com/"], index: 0 }
    const next = navigate(history, "https://d.com")
    expect(next).toEqual({ stack: ["https://a.com/", "https://d.com/"], index: 1 })
  })
  test("does not mutate input", () => {
    const history = { stack: ["https://a.com/"], index: 0 }
    const next = navigate(history, "https://b.com")
    expect(history.stack).toEqual(["https://a.com/"])
    expect(next).toEqual({ stack: ["https://a.com/", "https://b.com/"], index: 1 })
  })
})

describe("back / forward", () => {
  test("back moves index down", () => {
    const history = { stack: ["https://a.com/", "https://b.com/"], index: 1 }
    expect(back(history)).toEqual({ stack: ["https://a.com/", "https://b.com/"], index: 0 })
  })
  test("forward moves index up", () => {
    const history = { stack: ["https://a.com/", "https://b.com/"], index: 0 }
    expect(forward(history)).toEqual({ stack: ["https://a.com/", "https://b.com/"], index: 1 })
  })
  test("back at start is a no-op", () => {
    const history = { stack: ["https://a.com/"], index: 0 }
    expect(back(history)).toEqual(history)
  })
  test("forward at end is a no-op", () => {
    const history = { stack: ["https://a.com/", "https://b.com/"], index: 1 }
    expect(forward(history)).toEqual(history)
  })
})

describe("canBack / canForward / current", () => {
  test("initial history has no navigation", () => {
    expect(canBack(initialBrowserHistory)).toBe(false)
    expect(canForward(initialBrowserHistory)).toBe(false)
    expect(current(initialBrowserHistory)).toBeUndefined()
  })
  test("single entry can only go forward", () => {
    const history = { stack: ["https://a.com/"], index: 0 }
    expect(canBack(history)).toBe(false)
    expect(canForward(history)).toBe(false)
    expect(current(history)).toBe("https://a.com/")
  })
  test("middle entry can go both ways", () => {
    const history = { stack: ["https://a.com/", "https://b.com/", "https://c.com/"], index: 1 }
    expect(canBack(history)).toBe(true)
    expect(canForward(history)).toBe(true)
    expect(current(history)).toBe("https://b.com/")
  })
})

describe("migrate", () => {
  test("returns initial for null/undefined", () => {
    expect(migrate(null)).toEqual(initialBrowserHistory)
    expect(migrate(undefined)).toEqual(initialBrowserHistory)
  })
  test("returns initial for arrays", () => {
    expect(migrate([])).toEqual(initialBrowserHistory)
    expect(migrate([1, 2])).toEqual(initialBrowserHistory)
  })
  test("returns initial for malformed stack", () => {
    expect(migrate({ stack: [1, 2], index: 0 })).toEqual(initialBrowserHistory)
    expect(migrate({ stack: ["a"], index: "x" })).toEqual(initialBrowserHistory)
  })
  test("clamps index out of range", () => {
    expect(migrate({ stack: ["a", "b"], index: 99 })).toEqual({ stack: ["a", "b"], index: 1 })
    expect(migrate({ stack: ["a", "b"], index: -5 })).toEqual({ stack: ["a", "b"], index: -1 })
  })
  test("accepts valid history", () => {
    expect(migrate({ stack: ["a", "b"], index: 1 })).toEqual({ stack: ["a", "b"], index: 1 })
  })
})