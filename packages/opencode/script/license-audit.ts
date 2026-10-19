/**
 * Runs the FASE 31 licensing audit for the monorepo.
 *
 * The audit has two independent jobs:
 *
 * 1. classify every installed dependency by its SPDX license expression,
 *    falling back to the package LICENSE file when the manifest omits one;
 * 2. scan git-tracked source text for notices that point at copied or
 *    non-redistributable material.
 *
 * Usage: bun run packages/opencode/script/license-audit.ts [--json] [--strict] [--verbose]
 */
import { dirname, join } from "node:path"
import { readdir } from "node:fs/promises"
import { LicenseAudit } from "../src/licensing/audit"

const USAGE = `licensing audit

Usage: bun run packages/opencode/script/license-audit.ts [flags]

Flags:
  --json      print the full report as JSON
  --strict    also fail when dependencies need manual license review
  --verbose   list every review package and forbidden package
  --help      show this message

Runs against the installed dependency tree (node_modules/.bun) and the
git-tracked sources. Run "bun install" first.`

type Manifest = {
  readonly name?: unknown
  readonly version?: unknown
  readonly license?: unknown
  readonly licenses?: unknown
  readonly workspaces?: unknown
}

const flags = new Set(process.argv.slice(2))
if (flags.has("--help") || flags.has("-h")) {
  console.log(USAGE)
  process.exit(0)
}

/** Git grep pattern that covers every marker in `LicenseAudit.PROPRIETARY_MARKERS`. */
const SOURCE_GREP =
  "all rights reserved" +
  "|(confidential|proprietary)[[:space:]]+(and|&)[[:space:]]+(proprietary|confidential)" +
  "|unauthorized (copying|reproduction|use)" +
  "|for internal use only" +
  "|(do not|must not be|may not be) (cop(y|ies|ied|ying)|distribut(e|ed|ing)|redistribut(e|ed|ing)|disclos(e|ed|ing))"

const root = join(import.meta.dir, "../../..")
const dependencies = LicenseAudit.auditDependencies([
  ...(await collectWorkspaces(root)),
  ...(await collectInstalled(root)),
])
const sources = await scanSources(root)
const report = LicenseAudit.buildAuditReport(dependencies, sources)

if (flags.has("--json")) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(
    LicenseAudit.formatAuditReport(report, { strict: flags.has("--strict"), verbose: flags.has("--verbose") }),
  )
}
process.exit(LicenseAudit.auditExitCode(report, { strict: flags.has("--strict") }))

async function collectInstalled(root: string): Promise<LicenseAudit.DependencyInput[]> {
  const store = join(root, "node_modules", ".bun")
  const entries = await readdir(store, { withFileTypes: true }).catch(() => undefined)
  if (!entries) {
    throw new Error(`installed dependencies not found at ${store}; run "bun install" first`)
  }
  const inputs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const name = storeEntryName(entry.name)
        if (!name) return undefined
        const directory = join(store, entry.name, "node_modules", name)
        const manifest = await readManifest(join(directory, "package.json"))
        return manifest ? dependencyInput(directory, manifest) : undefined
      }),
  )
  return inputs.filter((input): input is LicenseAudit.DependencyInput => input !== undefined)
}

async function collectWorkspaces(root: string): Promise<LicenseAudit.DependencyInput[]> {
  const manifest = await readManifest(join(root, "package.json"))
  const patterns = workspacePatterns(manifest)
  const files = (
    await Promise.all(
      patterns.map((pattern) =>
        Array.fromAsync(new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root, onlyFiles: true })),
      ),
    )
  ).flat()
  const inputs = await Promise.all(
    files.map(async (file) => {
      const path = join(root, file)
      const manifest = await readManifest(path)
      return manifest ? dependencyInput(dirname(path), manifest) : undefined
    }),
  )
  return inputs.filter((input): input is LicenseAudit.DependencyInput => input !== undefined)
}

async function scanSources(root: string): Promise<LicenseAudit.SourceAudit> {
  const tracked = (await git(root, ["ls-files", "-z"])).split("\0").filter(Boolean)
  const scanned = tracked.filter(LicenseAudit.shouldScanSource)
  const allowed = new Set(scanned)
  // `git grep` reads the index instead of every file, so the audit stays fast
  // even on Windows. Exit code 1 simply means "no matches".
  const matches = await git(root, ["grep", "-n", "-I", "-i", "-E", "-e", SOURCE_GREP, "--", "."], true)
  const files = new Map<string, LicenseAudit.SourceHit[]>()
  for (const row of matches.split(/\r?\n/)) {
    const pathEnd = row.indexOf(":")
    const lineEnd = row.indexOf(":", pathEnd + 1)
    if (pathEnd < 0 || lineEnd < 0) continue
    const path = row.slice(0, pathEnd)
    if (!allowed.has(path)) continue
    const hits = LicenseAudit.scanSourceText(row.slice(lineEnd + 1))
    if (hits.length === 0) continue
    const line = Number(row.slice(pathEnd + 1, lineEnd))
    files.set(path, [...(files.get(path) ?? []), ...hits.map((hit) => ({ ...hit, line }))])
  }
  return {
    scanned: scanned.length,
    items: [...files.entries()].map(([path, hits]) => ({ path, hits })),
  }
}

async function git(root: string, args: string[], allowNoMatches = false): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" })
  const output = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code === 0) return output
  if (allowNoMatches && code === 1) return ""
  throw new Error(`git ${args[0]} failed with exit code ${code}`)
}

async function dependencyInput(
  directory: string,
  manifest: Manifest,
): Promise<LicenseAudit.DependencyInput | undefined> {
  if (typeof manifest.name !== "string") return undefined
  const license = declaredLicense(manifest)
  const licenseText = license === undefined ? await readLicenseText(directory) : undefined
  return {
    name: manifest.name,
    version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
    ...(license === undefined ? {} : { license }),
    ...(licenseText === undefined ? {} : { licenseText }),
  }
}

function declaredLicense(manifest: Manifest): string | undefined {
  if (typeof manifest.license === "string" && manifest.license.trim()) return manifest.license.trim()
  if (typeof manifest.license === "object" && manifest.license !== null && "type" in manifest.license) {
    const type = manifest.license.type
    if (typeof type === "string" && type.trim()) return type.trim()
  }
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || !("type" in entry)) return []
      return typeof entry.type === "string" ? [entry.type] : []
    })
    if (types.length > 0) return types.join(" OR ")
  }
  return undefined
}

async function readLicenseText(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory).catch(() => [])
  const file = entries.find((entry) => /^(?:licen[cs]e|copying|copyright)(?:[.\-_].*)?$/i.test(entry))
  if (!file) return undefined
  return Bun.file(join(directory, file))
    .text()
    .catch(() => undefined)
}

async function readManifest(path: string): Promise<Manifest | undefined> {
  const value: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined)
  if (typeof value !== "object" || value === null) return undefined
  return value as Manifest
}

function workspacePatterns(manifest: Manifest | undefined): string[] {
  if (!manifest || typeof manifest.workspaces !== "object" || manifest.workspaces === null) return []
  if (!("packages" in manifest.workspaces) || !Array.isArray(manifest.workspaces.packages)) return []
  return manifest.workspaces.packages.filter((item): item is string => typeof item === "string")
}

/** `.bun/effect@4.0.0` or `.bun/@scope+name@1.2.3+hash` to a package name. */
function storeEntryName(entry: string): string | undefined {
  const scoped = /^(@[^+]+)\+([^@]+)@/.exec(entry)
  if (scoped) return `${scoped[1]}/${scoped[2]}`
  return /^([^@]+)@/.exec(entry)?.[1]
}
