import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { SecurityScanner } from "@/security/scanner"
import DESCRIPTION from "./security.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Files or directories to scan, relative to the project root. Defaults to the whole project. Build and vendor directories (node_modules, .git, dist, ...) are always skipped.",
  }),
  categories: Schema.optional(Schema.Array(Schema.Literals([...SecurityScanner.Categories]))).annotate({
    description: "Restrict the scan to these rule categories. Defaults to all.",
  }),
})

type Metadata = {
  files: number
  findings: number
  critical: number
  high: number
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  ".svelte-kit",
  ".output",
  ".gradle",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
])

const MAX_FILES = 20000
const MAX_FILE_BYTES = 512 * 1024
const MAX_DEPTH = 32
const MAX_SHOWN = 120

export const SecurityTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service>(
  "security",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const root = ins.worktree || ins.directory
          const skipped = { outside: 0, missing: 0, binary: 0, large: 0 }
          const targets = yield* resolveTargets(fs, root, params.paths?.length ? params.paths : [root], skipped)
          const files: string[] = []
          for (const target of targets) yield* collectFiles(fs, target, 0, files)

          const findings: SecurityScanner.Finding[] = []
          let scanned = 0
          for (const file of files) {
            const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))
            if (!info || info.type !== "File") continue
            if (Number(info.size) > MAX_FILE_BYTES) {
              skipped.large++
              continue
            }
            const content = yield* fs.readFileStringSafe(file)
            if (content === undefined || content.includes("\u0000")) {
              skipped.binary++
              continue
            }
            scanned++
            findings.push(
              ...SecurityScanner.scan({
                file: path.relative(root, file),
                content,
                categories: params.categories,
              }),
            )
          }

          const summary = SecurityScanner.summarize(findings)
          const ordered = [...findings].sort(
            (a, b) =>
              SecurityScanner.severityRank(a.severity) - SecurityScanner.severityRank(b.severity) ||
              a.file.localeCompare(b.file) ||
              a.line - b.line,
          )
          const shown = ordered.slice(0, MAX_SHOWN)
          const notes = skipNotes(skipped, files.length >= MAX_FILES)
          const output = [
            `Static security scan — ${scanned} file(s) scanned, ${summary.total} finding(s)`,
            summary.total > 0
              ? `Severities: ${summary.severities
                  .filter((item) => item.count > 0)
                  .map((item) => `${item.count} ${item.severity}`)
                  .join(", ")}`
              : undefined,
            "",
            ...shown.flatMap((finding) => [
              `[${finding.severity}] ${finding.rule} — ${finding.message} (${finding.category})`,
              `  ${finding.file}:${finding.line}:${finding.column}`,
              `  ${finding.snippet}`,
              `  → ${finding.hint}`,
              "",
            ]),
            ordered.length > shown.length
              ? `…and ${ordered.length - shown.length} more finding(s); narrow the scan with "paths" or "categories".`
              : undefined,
            `Category coverage: ${summary.categories.map((item) => `${item.category}=${item.count}`).join(", ")}`,
            notes || undefined,
            "Findings are static-analysis candidates; verify each one in context before acting on it.",
            "Dependency versions are not audited here — run `bun audit` (or `npm audit`) as well.",
          ]
            .filter((line) => line !== undefined)
            .join("\n")

          return {
            title: summary.total > 0 ? `${summary.total} finding(s)` : "No findings",
            output,
            metadata: {
              files: scanned,
              findings: summary.total,
              critical: summary.severities.find((item) => item.severity === "critical")?.count ?? 0,
              high: summary.severities.find((item) => item.severity === "high")?.count ?? 0,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const resolveTargets = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  root: string,
  inputs: readonly string[],
  skipped: { outside: number; missing: number },
) {
  const targets: string[] = []
  for (const input of inputs) {
    const resolved = path.resolve(root, input)
    const relative = path.relative(root, resolved)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      skipped.outside++
      continue
    }
    if (!(yield* fs.existsSafe(resolved))) {
      skipped.missing++
      continue
    }
    targets.push(resolved)
  }
  return targets
})

function collectFiles(
  fs: FSUtil.Interface,
  target: string,
  depth: number,
  files: string[],
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return
    if (yield* fs.isDir(target)) {
      const entries = yield* fs.readDirectoryEntries(target).pipe(Effect.orElseSucceed(() => []))
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return
        if (entry.type === "symlink") continue
        if (entry.type === "directory" && IGNORED_DIRS.has(entry.name)) continue
        if (entry.type !== "directory" && entry.type !== "file") continue
        yield* collectFiles(fs, path.join(target, entry.name), depth + 1, files)
      }
      return
    }
    if (yield* fs.isFile(target)) files.push(target)
  })
}

function skipNotes(skipped: { outside: number; missing: number; binary: number; large: number }, truncated: boolean) {
  const notes = [
    skipped.outside > 0 ? `${skipped.outside} path(s) outside the project` : undefined,
    skipped.missing > 0 ? `${skipped.missing} path(s) not found` : undefined,
    skipped.binary > 0 ? `${skipped.binary} binary file(s)` : undefined,
    skipped.large > 0 ? `${skipped.large} file(s) over ${Math.round(MAX_FILE_BYTES / 1024)} KiB` : undefined,
    truncated ? `scan stopped after ${MAX_FILES} files` : undefined,
  ].filter((note) => note !== undefined)
  return notes.length > 0 ? `Skipped: ${notes.join(", ")}.` : ""
}
