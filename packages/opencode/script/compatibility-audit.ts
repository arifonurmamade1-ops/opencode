/**
 * Runs the FASE 32 compatibility audit for the monorepo.
 *
 * The audit snapshots the public surfaces (CLI, config, agents, tools, plugin,
 * TUI, HTTP API, and root scripts) and compares them with
 * `specs/compatibility/baseline.json`. A breaking change fails the audit until
 * it has a waiver with a reason, a migration, and a test that references it.
 *
 * Usage: bun run compatibility:audit [flags]
 */
import { join } from "node:path"
import type { Snapshot, Waiver } from "../src/compatibility/audit"

const USAGE = `compatibility audit

Usage: bun run compatibility:audit [flags]

Flags:
  --update   accept the current surfaces as the new baseline
  --force    with --update, accept breaking changes without a waiver
  --json     print the full report as JSON
  --help     show this message

Breaking changes are removed commands, config keys, agents, tools, plugin
hooks, TUI keybinds, API endpoints, or scripts, plus changed plugin versions
and changed TUI keybind defaults. They need a waiver in
specs/compatibility/waivers.json with a reason, a migration, and tests.`

const flags = new Set(process.argv.slice(2))
if (flags.has("--help") || flags.has("-h")) {
  console.log(USAGE)
  process.exit(0)
}
if (flags.has("--force") && !flags.has("--update")) {
  console.error("--force is only valid together with --update")
  process.exit(1)
}

const root = join(import.meta.dir, "../../..")
// Keep the heavy extraction imports dynamic so --help stays cheap.
const { Compatibility } = await import("../src/compatibility/audit")
const { CompatibilitySurface } = await import("../src/compatibility/surface")

const baselinePath = join(root, "specs", "compatibility", "baseline.json")
const waiversPath = join(root, "specs", "compatibility", "waivers.json")
const update = flags.has("--update")

const current = await CompatibilitySurface.extractSnapshot(root)
const hasBaseline = await Bun.file(baselinePath).exists()
if (!hasBaseline && !update) {
  console.error(`compatibility baseline not found at ${baselinePath}; run with --update first`)
  process.exit(1)
}
const baseline = hasBaseline ? await readBaseline(baselinePath) : current

const hasWaivers = await Bun.file(waiversPath).exists()
const waiverValue: unknown = hasWaivers ? await Bun.file(waiversPath).json() : { waivers: [] }
const parsed = Compatibility.parseWaivers(waiverValue)
const waiverProblems = hasWaivers || update ? parsed.problems : [`waivers file not found at ${waiversPath}`]
const readTest = await readTestFiles(root, parsed.waivers)
const report = Compatibility.compare({
  baseline,
  current,
  waivers: parsed.waivers,
  waiverProblems,
  readTest,
})

if (update) {
  if (report.problems.length > 0) {
    console.error(Compatibility.formatReport(report))
    console.error("\nrefusing to update the baseline while the waivers are invalid")
    process.exit(1)
  }
  if (report.unwaived.length > 0 && !flags.has("--force")) {
    console.error(Compatibility.formatReport(report))
    console.error(
      "\nrefusing to update the baseline: breaking changes need a waiver in specs/compatibility/waivers.json" +
        " (reason, migration, tests), or pass --force",
    )
    process.exit(1)
  }
  if (!hasWaivers) {
    await Bun.write(waiversPath, JSON.stringify({ waivers: [] }, null, 2) + "\n")
  }
  await Bun.write(baselinePath, JSON.stringify(current, null, 2) + "\n")
  console.log(Compatibility.formatReport(report, { hint: false }))
  console.log(`\nbaseline written to ${baselinePath}`)
  process.exit(0)
}

if (flags.has("--json")) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(Compatibility.formatReport(report))
}
process.exit(Compatibility.reportExitCode(report))

async function readBaseline(path: string): Promise<Snapshot> {
  const value: unknown = await Bun.file(path).json()
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid compatibility baseline at ${path}`)
  }
  const snapshot = value as Snapshot
  if (snapshot.version !== Compatibility.BASELINE_VERSION) {
    throw new Error(
      `compatibility baseline version ${snapshot.version} is not ${Compatibility.BASELINE_VERSION}; run with --update`,
    )
  }
  if (!snapshot.cli || !snapshot.config || !snapshot.plugin || !snapshot.tui || !Array.isArray(snapshot.agents)) {
    throw new Error(`invalid compatibility baseline shape at ${path}`)
  }
  return snapshot
}

async function readTestFiles(root: string, waivers: readonly Waiver[]): Promise<(path: string) => string | undefined> {
  const paths = [...new Set(waivers.flatMap((waiver) => waiver.tests))]
  const contents = new Map<string, string>()
  await Promise.all(
    paths.map(async (path) => {
      const text = await Bun.file(join(root, path))
        .text()
        .catch(() => undefined)
      if (text !== undefined) contents.set(path, text)
    }),
  )
  return (path) => contents.get(path)
}
