import { describe, expect, test } from "bun:test"
import { Schedule } from "../../src/scheduler/schedule"

/** Local wall-clock time so cron/day math is deterministic in any timezone. */
const local = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute).getTime()

describe("schedule.parseDuration", () => {
  test("parses supported units", () => {
    expect(Schedule.parseDuration("30s")).toBe(30_000)
    expect(Schedule.parseDuration("15m")).toBe(900_000)
    expect(Schedule.parseDuration("2h")).toBe(7_200_000)
    expect(Schedule.parseDuration("1d")).toBe(86_400_000)
    expect(Schedule.parseDuration("1w")).toBe(604_800_000)
  })

  test("rejects malformed durations", () => {
    expect(Schedule.parseDuration("soon")).toBeUndefined()
    expect(Schedule.parseDuration("0m")).toBeUndefined()
    expect(Schedule.parseDuration("5")).toBeUndefined()
  })
})

describe("schedule.nextRunAt", () => {
  test("runs immediate tasks as soon as possible", () => {
    const from = local(2026, 1, 5, 10, 0)
    expect(Schedule.nextRunAt({ type: "immediate" }, from)).toBe(from)
  })

  test("runs at tasks once, clamping past times to now", () => {
    const from = local(2026, 1, 5, 10, 0)
    expect(
      Schedule.nextRunAt({ type: "at", time: new Date(local(2026, 1, 5, 12, 0)).toISOString() }, from),
    ).toBe(local(2026, 1, 5, 12, 0))
    expect(
      Schedule.nextRunAt({ type: "at", time: new Date(local(2026, 1, 4, 8, 0)).toISOString() }, from),
    ).toBe(from)
    expect(Schedule.nextRunAt({ type: "at", time: "not a date" }, from)).toBeUndefined()
  })

  test("interval schedules count from now", () => {
    const from = local(2026, 1, 5, 10, 0)
    expect(Schedule.nextRunAt({ type: "interval", every: "30m" }, from)).toBe(from + 1_800_000)
    expect(Schedule.nextRunAt({ type: "interval", every: "nope" }, from)).toBeUndefined()
  })

  test("daily schedules pick the next local occurrence", () => {
    expect(Schedule.nextRunAt({ type: "daily", at: "08:00" }, local(2026, 1, 5, 7, 30))).toBe(
      local(2026, 1, 5, 8, 0),
    )
    expect(Schedule.nextRunAt({ type: "daily", at: "08:00" }, local(2026, 1, 5, 9, 0))).toBe(
      local(2026, 1, 6, 8, 0),
    )
  })

  test("condition schedules have no fixed run time", () => {
    expect(Schedule.nextRunAt({ type: "condition", check: "true" }, local(2026, 1, 5, 10, 0))).toBeUndefined()
  })
})

describe("schedule.nextCronAt", () => {
  // 2026-01-05 is a Monday.
  test("computes the next matching minute", () => {
    const from = local(2026, 1, 5, 10, 30)
    expect(Schedule.nextCronAt("0 22 * * *", from)).toBe(local(2026, 1, 5, 22, 0))
    expect(Schedule.nextCronAt("*/15 * * * *", from)).toBe(local(2026, 1, 5, 10, 45))
    expect(Schedule.nextCronAt("0 8 * * mon-fri", from)).toBe(local(2026, 1, 6, 8, 0))
  })

  test("skips to the next matching weekday", () => {
    expect(Schedule.nextCronAt("0 8 * * mon-fri", local(2026, 1, 9, 9, 0))).toBe(local(2026, 1, 12, 8, 0))
  })

  test("supports day and month restrictions", () => {
    expect(Schedule.nextCronAt("0 0 1 * *", local(2026, 1, 1, 0, 0))).toBe(local(2026, 2, 1, 0, 0))
    expect(Schedule.nextCronAt("30 6 1 jan *", local(2026, 6, 15, 0, 0))).toBe(local(2027, 1, 1, 6, 30))
  })

  test("rejects malformed expressions", () => {
    expect(Schedule.parseCron("0 8 * *")).toBeUndefined()
    expect(Schedule.parseCron("0 8 * * xyz")).toBeUndefined()
    expect(Schedule.parseCron("99 * * * *")).toBeUndefined()
  })
})

describe("schedule.validateSpec", () => {
  test("accepts valid specs", () => {
    expect(Schedule.validateSpec({ type: "immediate" })).toBeUndefined()
    expect(Schedule.validateSpec({ type: "daily", at: "08:00" })).toBeUndefined()
    expect(Schedule.validateSpec({ type: "cron", expression: "0 8 * * *" })).toBeUndefined()
    expect(Schedule.validateSpec({ type: "condition", check: "bun test" })).toBeUndefined()
  })

  test("reports invalid specs", () => {
    expect(Schedule.validateSpec({ type: "daily", at: "25:00" })).toBeString()
    expect(Schedule.validateSpec({ type: "interval", every: "5" })).toBeString()
    expect(Schedule.validateSpec({ type: "condition", check: " " })).toBeString()
  })
})

describe("schedule.describeSpec", () => {
  test("describes each kind", () => {
    expect(Schedule.describeSpec({ type: "immediate" })).toBe("once, as soon as possible")
    expect(Schedule.describeSpec({ type: "daily", at: "08:00" })).toBe("every day at 08:00")
    expect(Schedule.describeSpec({ type: "cron", expression: "0 8 * * *" })).toBe("cron 0 8 * * *")
    expect(Schedule.describeSpec({ type: "condition", check: "bun test", expect: "failure" })).toContain("fails")
  })
})
