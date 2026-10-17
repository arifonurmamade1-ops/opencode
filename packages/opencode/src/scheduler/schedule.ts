/**
 * Pure date math for the task scheduler.
 *
 * Everything works on epoch milliseconds and local server time. Keeping this
 * module free of Effect and services makes the scheduling rules unit-testable
 * without clocks or layers.
 */

export type Spec =
  | { type: "immediate" }
  | { type: "at"; time: string }
  | { type: "interval"; every: string }
  | { type: "daily"; at: string }
  | { type: "cron"; expression: string }
  | { type: "condition"; check: string; expect?: "success" | "failure"; every?: string }

export type ConditionSpec = Extract<Spec, { type: "condition" }>

export type Cron = {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
  dayRestricted: boolean
  weekdayRestricted: boolean
}

const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

export const DEFAULT_CHECK_INTERVAL = 5 * 60_000

/** Parses "30s", "15m", "2h", "1d" or "1w" into milliseconds. */
export function parseDuration(value: string) {
  const match = /^\s*(\d+)\s*(s|m|h|d|w)\s*$/.exec(value)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  return amount * DURATION_UNITS[match[2]!]!
}

/** Parses "08:00" style local times. */
export function parseTimeOfDay(value: string) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

/**
 * Parses a five field cron expression: minute hour day-of-month month
 * day-of-week. Supports `*`, single values, ranges, lists, steps and month or
 * weekday names.
 */
export function parseCron(expression: string): Cron | undefined {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const minute = parseField(fields[0]!, 0, 59)
  const hour = parseField(fields[1]!, 0, 23)
  const day = parseField(fields[2]!, 1, 31)
  const month = parseField(fields[3]!, 1, 12, MONTH_ALIASES)
  const weekday = parseField(fields[4]!, 0, 7, WEEKDAY_ALIASES)
  if (!minute || !hour || !day || !month || !weekday) return undefined
  return {
    minute,
    hour,
    day,
    month,
    weekday: new Set([...weekday].map((value) => (value === 7 ? 0 : value))),
    dayRestricted: fields[2]!.trim() !== "*",
    weekdayRestricted: fields[4]!.trim() !== "*",
  }
}

function parseField(text: string, min: number, max: number, aliases: Record<string, number> = {}) {
  const values = new Set<number>()
  const resolve = (token: string) => {
    const normalized = token.trim().toLowerCase()
    if (normalized in aliases) return aliases[normalized]
    if (!/^\d+$/.test(normalized)) return undefined
    const value = Number(normalized)
    return value >= min && value <= max ? value : undefined
  }
  for (const part of text.split(",")) {
    const segments = part.trim().split("/")
    if (segments.length > 2) return undefined
    const step = segments.length === 2 ? Number(segments[1]) : 1
    if (!Number.isInteger(step) || step < 1) return undefined
    const span = segments[0]!.trim()
    if (span === "*") {
      for (let value = min; value <= max; value += step) values.add(value)
      continue
    }
    const bounds = span.split("-")
    if (bounds.length > 2) return undefined
    const start = resolve(bounds[0]!)
    if (start === undefined) return undefined
    const end = bounds.length === 2 ? resolve(bounds[1]!) : segments.length === 2 ? max : start
    if (end === undefined || start > end) return undefined
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values.size > 0 ? values : undefined
}

/** Next matching local minute strictly after `from`. */
export function nextCronAt(expression: string, from: number) {
  const cron = parseCron(expression)
  if (!cron) return undefined
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)
  const deadline = from + 4 * 366 * 86_400_000
  while (candidate.getTime() <= deadline) {
    if (!cron.month.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1)
      candidate.setHours(0, 0, 0, 0)
      continue
    }
    const day = cron.day.has(candidate.getDate())
    const weekday = cron.weekday.has(candidate.getDay())
    const dayMatches = cron.dayRestricted && cron.weekdayRestricted ? day || weekday : day && weekday
    if (!dayMatches) {
      candidate.setDate(candidate.getDate() + 1)
      candidate.setHours(0, 0, 0, 0)
      continue
    }
    if (!cron.hour.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!cron.minute.has(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1)
      continue
    }
    return candidate.getTime()
  }
  return undefined
}

export function conditionInterval(spec: ConditionSpec) {
  return (spec.every ? parseDuration(spec.every) : undefined) ?? DEFAULT_CHECK_INTERVAL
}

/** Next run time for a one-shot or recurring spec, `undefined` for conditions. */
export function nextRunAt(spec: Spec, from: number): number | undefined {
  switch (spec.type) {
    case "immediate":
      return from
    case "at": {
      const time = Date.parse(spec.time)
      if (Number.isNaN(time)) return undefined
      return Math.max(time, from)
    }
    case "interval": {
      const every = parseDuration(spec.every)
      if (every === undefined) return undefined
      return from + every
    }
    case "daily": {
      const time = parseTimeOfDay(spec.at)
      if (!time) return undefined
      const next = new Date(from)
      next.setSeconds(0, 0)
      next.setHours(time.hour, time.minute, 0, 0)
      if (next.getTime() <= from) next.setDate(next.getDate() + 1)
      return next.getTime()
    }
    case "cron":
      return nextCronAt(spec.expression, from)
    case "condition":
      return undefined
  }
}

export function validateSpec(spec: Spec): string | undefined {
  switch (spec.type) {
    case "immediate":
      return undefined
    case "at":
      return Number.isNaN(Date.parse(spec.time))
        ? `Invalid time "${spec.time}". Use an ISO-8601 date-time.`
        : undefined
    case "interval":
      return parseDuration(spec.every) === undefined
        ? `Invalid duration "${spec.every}". Use values like 30m, 1h, 1d.`
        : undefined
    case "daily":
      return parseTimeOfDay(spec.at) === undefined ? `Invalid time "${spec.at}". Use HH:MM.` : undefined
    case "cron": {
      if (parseCron(spec.expression) === undefined)
        return `Invalid cron expression "${spec.expression}". Use five fields, e.g. "0 8 * * *".`
      if (nextCronAt(spec.expression, Date.now()) === undefined)
        return `Cron expression "${spec.expression}" never matches.`
      return undefined
    }
    case "condition": {
      if (!spec.check.trim()) return "The condition check command cannot be empty."
      if (spec.every !== undefined && parseDuration(spec.every) === undefined)
        return `Invalid duration "${spec.every}". Use values like 30m, 1h, 1d.`
      return undefined
    }
  }
}

export function describeSpec(spec: Spec): string {
  switch (spec.type) {
    case "immediate":
      return "once, as soon as possible"
    case "at":
      return `once at ${spec.time}`
    case "interval":
      return `every ${spec.every}`
    case "daily":
      return `every day at ${spec.at}`
    case "cron":
      return `cron ${spec.expression}`
    case "condition":
      return `when \`${spec.check}\` ${spec.expect === "failure" ? "fails" : "succeeds"} (checked every ${spec.every ?? "5m"})`
  }
}

export * as Schedule from "./schedule"
