#!/usr/bin/env bun
/**
 * Startup performance audit — FASE 33.
 *
 * Spawns the real CLI entrypoint in fresh processes and reports wall time,
 * peak RSS, and CPU time. The `--check` mode is a coarse regression gate: it
 * only asserts that the version probe stays on the lightweight bootstrap path.
 * See specs/performance/README.md for the measurement methodology.
 */
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { join } from "node:path"

const packageDir = join(import.meta.dir, "..")
const repoRoot = join(packageDir, "..", "..")
const entry = join(packageDir, "src", "index.ts")
const VERSION_BUDGET_MS = 15_000

const argv = process.argv.slice(2)
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Startup performance audit

Usage:
  bun run script/performance-audit.ts [options]

Options:
  --runs <n>   samples per command after one warmup (default: 3)
  --full       also measure top-level --help
  --json       print machine-readable results
  --check      fail if the version startup median exceeds ${VERSION_BUDGET_MS}ms
  --help       show this help
`)
  process.exit(0)
}

const runs = readNumber("--runs", 3)
if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
  console.error("--runs must be an integer between 1 and 10")
  process.exit(1)
}

const full = argv.includes("--full")
const json = argv.includes("--json")
const check = argv.includes("--check")

type Sample = {
  wall_ms: number
  cpu_ms?: number
  rss_mb?: number
  exit_code: number
  stdout: string
  stderr: string
}

type Measurement = {
  name: string
  flags: string[]
  samples: Sample[]
  median_wall_ms: number
  min_wall_ms: number
  max_wall_ms: number
}

const measurements: Measurement[] = []
await measure("version", ["--version"])
if (full) await measure("help", ["--help"])

const failures: string[] = []
for (const measurement of measurements) {
  for (const sample of measurement.samples) {
    if (sample.exit_code !== 0) failures.push(`${measurement.name} exited with ${sample.exit_code}`)
  }
}

const version = measurements.find((measurement) => measurement.name === "version")
if (version) {
  for (const sample of version.samples) {
    if (sample.stdout.trim() !== InstallationVersion) {
      failures.push(
        `version output was ${JSON.stringify(sample.stdout.trim())}, expected ${JSON.stringify(InstallationVersion)}`,
      )
    }
  }
  if (check && version.median_wall_ms > VERSION_BUDGET_MS) {
    failures.push(
      `version median ${formatMs(version.median_wall_ms)} exceeded the ${formatMs(VERSION_BUDGET_MS)} budget`,
    )
  }
}

if (json) {
  console.log(
    JSON.stringify(
      {
        entry,
        runs,
        warmup: true,
        budget_ms: VERSION_BUDGET_MS,
        measurements,
        failures,
      },
      null,
      2,
    ),
  )
} else {
  console.log(`startup audit (${runs} run${runs === 1 ? "" : "s"} after one warmup)`)
  console.log("")
  console.log(
    `${"command".padEnd(10)} ${"median".padStart(10)} ${"min".padStart(10)} ${"max".padStart(10)} ${"cpu".padStart(10)} ${"rss".padStart(10)}`,
  )
  for (const measurement of measurements) {
    const cpu = median(measurement.samples.flatMap((sample) => (sample.cpu_ms === undefined ? [] : [sample.cpu_ms])))
    const rss = median(measurement.samples.flatMap((sample) => (sample.rss_mb === undefined ? [] : [sample.rss_mb])))
    console.log(
      `${measurement.name.padEnd(10)} ${formatMs(measurement.median_wall_ms).padStart(10)} ${formatMs(measurement.min_wall_ms).padStart(10)} ${formatMs(measurement.max_wall_ms).padStart(10)} ${formatMs(cpu).padStart(10)} ${formatMb(rss).padStart(10)}`,
    )
  }
  for (const failure of failures) console.error(`\nfail: ${failure}`)
}

if (failures.length > 0) process.exitCode = 1

async function measure(name: string, flags: string[]) {
  // Warm the OS file cache and catch a broken command before recording samples.
  await run(flags)
  const samples: Sample[] = []
  for (let index = 0; index < runs; index++) samples.push(await run(flags))
  const walls = samples.map((sample) => sample.wall_ms)
  measurements.push({
    name,
    flags,
    samples,
    median_wall_ms: median(walls),
    min_wall_ms: Math.min(...walls),
    max_wall_ms: Math.max(...walls),
  })
}

async function run(flags: string[]): Promise<Sample> {
  const started = performance.now()
  const proc = Bun.spawn([process.execPath, entry, ...flags], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  const usage = proc.resourceUsage()
  const rss = usage === undefined ? undefined : numeric(usage.maxRSS)
  // maxRSS follows getrusage units: KiB on Linux/Windows, bytes on macOS.
  const rssMb = rss === undefined ? undefined : process.platform === "darwin" ? rss / 1024 / 1024 : rss / 1024
  return {
    wall_ms: Math.round(performance.now() - started),
    cpu_ms: usage === undefined ? undefined : Math.round(numeric(usage.cpuTime.total) / 1000),
    rss_mb: rssMb === undefined ? undefined : Math.round(rssMb),
    exit_code: exitCode,
    stdout,
    stderr,
  }
}

function readNumber(name: string, fallback: number) {
  const index = argv.indexOf(name)
  if (index === -1) return fallback
  return Number(argv[index + 1])
}

// Bun exposes these as numbers in its types, but Windows returns BigInts at
// runtime. Normalize both without an unchecked assertion.
function numeric(value: number | bigint) {
  return typeof value === "bigint" ? Number(value) : value
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
}

function formatMs(value: number | undefined) {
  return value === undefined || value === 0 ? "n/a" : `${value}ms`
}

function formatMb(value: number) {
  return value === 0 ? "n/a" : `${value}MB`
}
