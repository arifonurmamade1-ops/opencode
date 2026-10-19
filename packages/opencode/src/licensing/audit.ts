/**
 * Proprietary implementation guard — FASE 31.
 *
 * We may study public documentation and public feature descriptions of other
 * tools, but we must not copy proprietary code, implementations, assets,
 * marks, protected UI, or closed components. This module is the pure part of
 * the guard: it classifies SPDX license expressions, infers a license from a
 * license text, and scans source text for "proprietary/copied" markers.
 *
 * `script/license-audit.ts` feeds it the installed dependency tree and the
 * git-tracked sources; CI runs the audit on every push.
 */

export type LicenseClass = "allowed" | "review" | "forbidden"

export type LicenseVerdict = {
  readonly license: string | undefined
  readonly class: LicenseClass
  readonly reason: string
}

type Expression =
  | { readonly type: "license"; readonly id: string }
  | { readonly type: "and" | "or"; readonly left: Expression; readonly right: Expression }

const ALLOWED_LICENSES: Record<string, string> = {
  "0bsd": "0BSD is a permissive public-domain-equivalent license",
  mit: "MIT is a permissive license",
  "mit-0": "MIT-0 is a permissive license without an attribution requirement",
  "mit/x11": "MIT/X11 is a permissive license",
  x11: "X11 is a permissive license",
  expat: "Expat is the MIT license under its alternative name",
  isc: "ISC is a permissive license",
  "bsd-2-clause": "BSD-2-Clause is a permissive license",
  "bsd-3-clause": "BSD-3-Clause is a permissive license; keep the attribution notice",
  "apache-2.0": "Apache-2.0 is a permissive license; keep the NOTICE attribution",
  unlicense: "The Unlicense places the work in the public domain",
  "cc0-1.0": "CC0-1.0 waives copyright and related rights",
  "blueoak-1.0.0": "Blue Oak 1.0.0 is a permissive license",
  "python-2.0": "Python-2.0 is a permissive license",
  wtfpl: "WTFPL grants unrestricted use",
  zlib: "zlib is a permissive license",
  "bsl-1.0": "Boost 1.0 is a permissive license",
  "ofl-1.1": "OFL-1.1 allows bundling fonts while keeping the font copyright notice",
  "cc-by-4.0": "CC-BY-4.0 allows content reuse with attribution",
  "cc-by-3.0": "CC-BY-3.0 allows content reuse with attribution",
}

const REVIEW_LICENSES: Record<string, string> = {
  "mpl-2.0": "MPL-2.0 is file-level copyleft; fine as an unmodified dependency, review modifications",
  "lgpl-2.1": "LGPL-2.1 is weak copyleft; review linking and distribution before bundling",
  "lgpl-3.0": "LGPL-3.0 is weak copyleft; review linking and distribution before bundling",
  "epl-1.0": "EPL-1.0 is weak copyleft; review before bundling",
  "epl-2.0": "EPL-2.0 is weak copyleft; review before bundling",
  "cddl-1.0": "CDDL-1.0 is file-level copyleft; review before bundling",
  "cddl-1.1": "CDDL-1.1 is file-level copyleft; review before bundling",
  "afl-2.1": "AFL-2.1 is permissive but has patent and termination terms that need review",
  "afl-3.0": "AFL-3.0 is permissive but has patent and termination terms that need review",
  "artistic-2.0": "Artistic-2.0 has distribution conditions that need review",
  "fsl-1.1-mit": "FSL-1.1-MIT is source-available and only converts to MIT after two years; review before bundling",
  "cc-by-sa-3.0": "CC-BY-SA-3.0 is share-alike content; review before bundling",
  "cc-by-sa-4.0": "CC-BY-SA-4.0 is share-alike content; review before bundling",
  bsd: "the BSD variant is unspecified; confirm which clauses apply",
}

const FORBIDDEN_LICENSES: Record<string, string> = {
  "gpl-2.0": "GPL-2.0 is strong copyleft; it cannot be bundled into this MIT-licensed product",
  "gpl-3.0": "GPL-3.0 is strong copyleft; it cannot be bundled into this MIT-licensed product",
  "agpl-3.0": "AGPL-3.0 is strong network copyleft; it cannot be bundled into this MIT-licensed product",
  "sspl-1.0": "SSPL-1.0 is source-available with service restrictions; it is not redistributable here",
  "busl-1.1": "BUSL-1.1 is source-available with competitive restrictions; it is not redistributable here",
  "elastic-2.0": "Elastic-2.0 is source-available with service restrictions; it is not redistributable here",
  "cc-by-nc-4.0": "CC-BY-NC-4.0 forbids commercial use",
  "cc-by-nc-sa-4.0": "CC-BY-NC-SA-4.0 forbids commercial use and is share-alike",
  unlicensed: "UNLICENSED means no permission to redistribute was granted",
  proprietary: "proprietary terms do not grant redistribution rights",
  "all-rights-reserved": "an all-rights-reserved notice grants no redistribution rights",
}

/**
 * Classifies an SPDX license expression. `undefined` means the manifest did
 * not declare a license; that is a review item, never a silent pass.
 */
export function classifyLicense(expression: string | undefined): LicenseVerdict {
  const license = expression?.trim()
  if (!license) {
    return {
      license: undefined,
      class: "review",
      reason: "no license declared; confirm the terms before redistributing",
    }
  }
  if (/^see license in\b/i.test(license)) {
    return { license, class: "review", reason: "the license is defined in a separate file; review that file" }
  }
  const node = parseLicenseExpression(license)
  if (!node) {
    return {
      license,
      class: "review",
      reason: `unrecognized license expression "${license}"; confirm the terms before redistributing`,
    }
  }
  return { license, ...classifyNode(node) }
}

/** Parses a small SPDX grammar: identifiers, `WITH` exceptions, `AND`, `OR`, and parentheses. */
export function parseLicenseExpression(expression: string): Expression | undefined {
  const tokens = expression.match(/\(|\)|[^\s()]+/g)
  if (!tokens) return undefined
  const parsed = parseOr(tokens, 0)
  if (!parsed || parsed.next !== tokens.length) return undefined
  return parsed.node
}

function parseOr(tokens: readonly string[], index: number): { node: Expression; next: number } | undefined {
  const first = parseAnd(tokens, index)
  if (!first || !isKeyword(tokens[first.next], "or")) return first
  const rest = parseOr(tokens, first.next + 1)
  if (!rest) return undefined
  return { node: { type: "or", left: first.node, right: rest.node }, next: rest.next }
}

function parseAnd(tokens: readonly string[], index: number): { node: Expression; next: number } | undefined {
  const first = parsePrimary(tokens, index)
  if (!first || !isKeyword(tokens[first.next], "and")) return first
  const rest = parseAnd(tokens, first.next + 1)
  if (!rest) return undefined
  return { node: { type: "and", left: first.node, right: rest.node }, next: rest.next }
}

function parsePrimary(tokens: readonly string[], index: number): { node: Expression; next: number } | undefined {
  if (tokens[index] === "(") {
    const inner = parseOr(tokens, index + 1)
    if (!inner || tokens[inner.next] !== ")") return undefined
    return { node: inner.node, next: inner.next + 1 }
  }
  const id = tokens[index]
  if (!id || id === ")" || isKeyword(id, "and") || isKeyword(id, "or")) return undefined
  if (isKeyword(tokens[index + 1], "with")) {
    const exception = tokens[index + 2]
    if (!exception) return undefined
    return { node: { type: "license", id: `${id} WITH ${exception}` }, next: index + 3 }
  }
  return { node: { type: "license", id }, next: index + 1 }
}

function isKeyword(token: string | undefined, keyword: "and" | "or" | "with"): boolean {
  return token?.toLowerCase() === keyword
}

function classifyNode(node: Expression): { class: LicenseClass; reason: string } {
  if (node.type === "license") return classifyIdentifier(node.id)
  const left = classifyNode(node.left)
  const right = classifyNode(node.right)
  if (node.type === "and") {
    if (left.class === "forbidden" || right.class === "forbidden") {
      return { class: "forbidden", reason: left.class === "forbidden" ? left.reason : right.reason }
    }
    if (left.class === "review" || right.class === "review") {
      return { class: "review", reason: left.class === "review" ? left.reason : right.reason }
    }
    return { class: "allowed", reason: "every component of the expression is permissive" }
  }
  if (left.class === "allowed" || right.class === "allowed") {
    return { class: "allowed", reason: left.class === "allowed" ? left.reason : right.reason }
  }
  if (left.class === "review" || right.class === "review") {
    return { class: "review", reason: left.class === "review" ? left.reason : right.reason }
  }
  return { class: "forbidden", reason: left.reason }
}

function classifyIdentifier(id: string): { class: LicenseClass; reason: string } {
  const withException = /^(.*\S)\s+with\s+(\S+)$/i.exec(id)
  if (withException) {
    const base = classifyIdentifier(withException[1])
    const exception = withException[2].toLowerCase()
    if (exception === "llvm-exception" && base.class === "allowed") {
      return { class: "allowed", reason: `${withException[1]} keeps its permissive terms with the LLVM exception` }
    }
    if (exception === "classpath-exception-2.0") {
      return {
        class: "review",
        reason: "GPL with the Classpath exception allows linking, but bundled distribution still needs review",
      }
    }
    return { class: "review", reason: `license exception "${withException[2]}" needs review` }
  }
  const normalized = normalizeLicenseID(id)
  const allowed = ALLOWED_LICENSES[normalized]
  if (allowed) return { class: "allowed", reason: allowed }
  const review = REVIEW_LICENSES[normalized]
  if (review) return { class: "review", reason: review }
  const forbidden = FORBIDDEN_LICENSES[normalized]
  if (forbidden) return { class: "forbidden", reason: forbidden }
  return {
    class: "review",
    reason: `unrecognized license "${id}"; confirm the terms before redistributing`,
  }
}

function normalizeLicenseID(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\+$/, "")
    .replace(/-(?:only|or-later)$/, "")
}

/**
 * Reads a license name from a license text. Only the start of the file is
 * inspected; this is a review aid, not legal advice.
 */
export function inferLicenseFromText(text: string): string | undefined {
  const sample = text.slice(0, 8000)
  if (/^\s*unlicensed\b/im.test(sample)) return "UNLICENSED"
  if (/\bSIL OPEN FONT LICENSE\b/i.test(sample)) return "OFL-1.1"
  if (/\bGNU AFFERO GENERAL PUBLIC LICENSE\b/i.test(sample)) return "AGPL-3.0"
  if (/\bGNU LESSER GENERAL PUBLIC LICENSE\b/i.test(sample)) {
    return /version 2\.1/i.test(sample) ? "LGPL-2.1" : "LGPL-3.0"
  }
  if (/\bGNU GENERAL PUBLIC LICENSE\b/i.test(sample)) {
    return /version 3/i.test(sample) ? "GPL-3.0" : "GPL-2.0"
  }
  if (/\bMOZILLA PUBLIC LICENSE\b/i.test(sample)) return "MPL-2.0"
  if (/\bFUNCTIONAL SOURCE LICENSE\b/i.test(sample)) return "FSL-1.1-MIT"
  if (/\bAPACHE LICENSE\b/i.test(sample) && /\bversion 2\.0\b/i.test(sample)) return "Apache-2.0"
  if (/\bBSD ZERO CLAUSE\b/i.test(sample)) return "0BSD"
  if (/\bBLUE OAK MODEL LICENSE\b/i.test(sample)) return "BlueOak-1.0.0"
  if (/\bCC0 1\.0\b/i.test(sample)) return "CC0-1.0"
  if (/\bCREATIVE COMMONS ATTRIBUTION 4\.0\b/i.test(sample)) return "CC-BY-4.0"
  if (/\bTHE UNLICENSE\b/i.test(sample) || /this is free and unencumbered software/i.test(sample)) {
    return "Unlicense"
  }
  if (/permission is hereby granted, free of charge/i.test(sample)) return "MIT"
  if (/permission to use, copy, modify, and\/or distribute this software/i.test(sample)) return "ISC"
  if (/redistribution and use in source and binary forms/i.test(sample)) {
    return /neither the name/i.test(sample) ? "BSD-3-Clause" : "BSD-2-Clause"
  }
  if (/\ball rights reserved\b/i.test(sample)) return "proprietary"
  return undefined
}

export const PROPRIETARY_MARKERS = [
  {
    id: "all-rights-reserved",
    description: "an all-rights-reserved notice reserves a work for another owner",
    pattern: /\ball rights reserved\b/i,
  },
  {
    id: "confidential-proprietary",
    description: "a confidential/proprietary notice marks closed material",
    pattern: /\b(?:confidential|proprietary)\s+(?:and|&)\s+(?:proprietary|confidential)\b/i,
  },
  {
    id: "unauthorized-copying",
    description: "an anti-copying notice suggests the text was copied from somewhere else",
    pattern: /\bunauthorized (?:copying|reproduction|use)\b/i,
  },
  {
    id: "do-not-distribute",
    description: "a non-distribution notice conflicts with shipping the code",
    pattern:
      /\b(?:do not|must not be|may not be) (?:cop(?:y|ies|ied|ying)|distribut(?:e|ed|ing)|redistribut(?:e|ed|ing)|disclos(?:e|ed|ing))\b/i,
  },
  {
    id: "internal-use-only",
    description: "an internal-use-only notice conflicts with shipping the code",
    pattern: /\bfor internal use only\b/i,
  },
] as const

export type SourceHit = {
  readonly line: number
  readonly marker: string
  readonly snippet: string
}

export function scanSourceText(text: string): SourceHit[] {
  const lines = text.split(/\r?\n/)
  return lines.flatMap((line, index) =>
    PROPRIETARY_MARKERS.filter((marker) => marker.pattern.test(line)).map((marker) => ({
      line: index + 1,
      marker: marker.id,
      snippet: line.trim().replace(/\s+/g, " ").slice(0, 160),
    })),
  )
}

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".turbo",
  ".cache",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "specs",
  "docs",
])

const IGNORED_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "icns",
  "bmp",
  "tiff",
  "svg",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "tar",
  "jar",
  "exe",
  "dll",
  "so",
  "dylib",
  "node",
  "wasm",
  "onnx",
  "bin",
  "db",
  "sqlite",
  "sqlite3",
  "lock",
  "map",
])

const LICENSE_FILE =
  /^(?:licen[cs]e|copying|copyright|notice|third[-_. ]?party|patents?|authors?|contributors?)(?:[.\-_].*)?$/i
const TEST_FILE = /\.(?:test|spec)\.[^./\\]+$/i

/**
 * Decides whether a tracked path is source text worth scanning. License
 * files, documentation, tests, lockfiles, and binary assets are skipped on
 * purpose: they may legally carry third-party copyright text or binaries.
 */
export function shouldScanSource(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean)
  const name = segments.at(-1) ?? ""
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment.toLowerCase()))) return false
  if (LICENSE_FILE.test(name) || TEST_FILE.test(name)) return false
  if (name === "bun.lock" || name === "bun.lockb") return false
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined
  return extension === undefined || !IGNORED_EXTENSIONS.has(extension)
}

export type DependencySource = "manifest" | "license-file" | "missing"

export type DependencyInput = {
  readonly name: string
  readonly version: string
  readonly license?: string
  /** License file text, used when the manifest does not declare a license. */
  readonly licenseText?: string
}

export type DependencyEntry = {
  readonly name: string
  readonly version: string
  readonly license: string | undefined
  readonly class: LicenseClass
  readonly reason: string
  readonly source: DependencySource
}

export function auditDependencies(inputs: readonly DependencyInput[]): DependencyEntry[] {
  const seen = new Set<string>()
  return inputs.flatMap((input): DependencyEntry[] => {
    const key = `${input.name}@${input.version}`
    if (seen.has(key)) return []
    seen.add(key)
    return [dependencyEntry(input)]
  })
}

function dependencyEntry(input: DependencyInput): DependencyEntry {
  const declared = input.license?.trim()
  if (declared) {
    return { name: input.name, version: input.version, source: "manifest", ...classifyLicense(declared) }
  }
  const inferred = input.licenseText ? inferLicenseFromText(input.licenseText) : undefined
  if (inferred) {
    return { name: input.name, version: input.version, source: "license-file", ...classifyLicense(inferred) }
  }
  return { name: input.name, version: input.version, source: "missing", ...classifyLicense(undefined) }
}

export type SourceFile = {
  readonly path: string
  readonly text: string
}

export type SourceFinding = {
  readonly path: string
  readonly hits: readonly SourceHit[]
}

export type SourceAudit = {
  readonly scanned: number
  readonly items: readonly SourceFinding[]
}

export function auditSources(files: readonly SourceFile[]): SourceAudit {
  return {
    scanned: files.length,
    items: files.flatMap((file) => {
      const hits = scanSourceText(file.text)
      return hits.length === 0 ? [] : [{ path: file.path, hits }]
    }),
  }
}

export type AuditReport = {
  readonly dependencies: {
    readonly total: number
    readonly allowed: number
    readonly review: number
    readonly forbidden: number
    readonly items: readonly DependencyEntry[]
  }
  readonly sources: {
    readonly scanned: number
    readonly flagged: number
    readonly items: readonly SourceFinding[]
  }
  readonly verdict: "pass" | "fail"
}

export function buildAuditReport(dependencies: readonly DependencyEntry[], sources: SourceAudit): AuditReport {
  const forbidden = dependencies.filter((item) => item.class === "forbidden")
  const review = dependencies.filter((item) => item.class === "review")
  return {
    dependencies: {
      total: dependencies.length,
      allowed: dependencies.length - forbidden.length - review.length,
      review: review.length,
      forbidden: forbidden.length,
      items: dependencies,
    },
    sources: { scanned: sources.scanned, flagged: sources.items.length, items: sources.items },
    verdict: forbidden.length > 0 || sources.items.length > 0 ? "fail" : "pass",
  }
}

export function formatAuditReport(
  report: AuditReport,
  options: { readonly verbose?: boolean; readonly strict?: boolean } = {},
): string {
  const lines = [
    "licensing audit",
    "",
    `  dependencies  ${report.dependencies.total} packages (${report.dependencies.allowed} allowed, ${report.dependencies.review} review, ${report.dependencies.forbidden} forbidden)`,
    `  sources       ${report.sources.scanned} files scanned (${report.sources.flagged} flagged)`,
  ]

  const forbidden = report.dependencies.items.filter((item) => item.class === "forbidden")
  if (forbidden.length > 0) {
    lines.push("", "forbidden dependencies")
    const visible = options.verbose ? forbidden : forbidden.slice(0, 25)
    lines.push(...visible.map((item) => `  ${item.name}@${item.version} [${item.license ?? "missing"}] ${item.reason}`))
    if (!options.verbose && forbidden.length > visible.length) {
      lines.push(`  ... ${forbidden.length - visible.length} more (use --verbose)`)
    }
  }

  const review = report.dependencies.items.filter((item) => item.class === "review")
  if (review.length > 0) {
    const groups = review.reduce((acc, item) => {
      const key = item.license ?? "missing declaration"
      acc.set(key, [...(acc.get(key) ?? []), item])
      return acc
    }, new Map<string, DependencyEntry[]>())
    lines.push("", "dependencies needing review")
    for (const [license, items] of [...groups.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${license} - ${items.length} package(s)`)
      if (options.verbose)
        lines.push(
          `    ${items
            .map((item) => item.name)
            .toSorted()
            .join(", ")}`,
        )
    }
  }

  if (report.sources.items.length > 0) {
    lines.push("", "source findings")
    for (const file of report.sources.items) {
      for (const hit of file.hits) {
        lines.push(`  ${file.path}:${hit.line} [${hit.marker}] ${hit.snippet}`)
      }
    }
  }

  const strictFailure = options.strict === true && report.dependencies.review > 0
  const pass = report.verdict === "pass" && !strictFailure
  const note =
    strictFailure && report.verdict === "pass" ? ` (--strict: ${report.dependencies.review} review item(s))` : ""
  lines.push("", `verdict: ${pass ? "PASS" : "FAIL"}${note}`)
  return lines.join("\n")
}

export function auditExitCode(report: AuditReport, options: { readonly strict?: boolean } = {}): number {
  if (report.verdict === "fail") return 1
  if (options.strict === true && report.dependencies.review > 0) return 1
  return 0
}

export * as LicenseAudit from "./audit"
