/**
 * FASE 24 — git intelligence.
 *
 * Deterministic analysis over the change data the Git service already exposes
 * (porcelain status, numstat stats, two-ref diffs). Everything here is pure:
 * callers gather git output, this module explains it, and no function runs a
 * command, rewrites history, or pushes. Suggestions (messages, branch names,
 * PR drafts) are proposals the user or the agent can override.
 */

import type { Item, Stat } from "./index"

export type FileKind = "test" | "docs" | "config" | "schema" | "source"

const conflictDescriptions: Record<string, string> = {
  DD: "deleted by both sides",
  AU: "added by us",
  UD: "deleted by them",
  UA: "added by them",
  DU: "deleted by us",
  AA: "added by both sides",
  UU: "modified by both sides",
}

const unix = (file: string) => file.replaceAll("\\", "/")

export function isConflicted(code: string) {
  return code.includes("U") || code === "AA" || code === "DD"
}

export function isUntracked(code: string) {
  return code === "??"
}

export function isStaged(code: string) {
  return !isUntracked(code) && !isConflicted(code) && code[0] !== " "
}

export function isUnstaged(code: string) {
  return !isUntracked(code) && !isConflicted(code) && code.length > 1 && code[1] !== " "
}

export function describeConflict(code: string) {
  return conflictDescriptions[code] ?? "unmerged"
}

export function area(file: string) {
  const parts = unix(file).split("/").filter(Boolean)
  if (parts.length <= 1) return "."
  if (parts[0] === "packages" && parts[1]) return parts[1]
  return parts[0]
}

export function classify(file: string): FileKind {
  const lower = unix(file).toLowerCase()
  const name = lower.split("/").pop() ?? lower
  if (/\.(test|spec)\.[^.]+$/.test(name) || /(^|\/)(tests?|__tests__|spec)\//.test(lower)) return "test"
  if (
    name.endsWith(".md") ||
    name.endsWith(".mdx") ||
    name.endsWith(".rst") ||
    lower.startsWith("docs/") ||
    lower.includes("/docs/")
  )
    return "docs"
  if (name.endsWith(".sql") || /(^|\/)migrations?\//.test(lower)) return "schema"
  if (
    /\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|lock|lockb)$/.test(name) ||
    lower.startsWith(".github/") ||
    lower.includes("/.github/") ||
    name === "dockerfile" ||
    name.startsWith("dockerfile.")
  )
    return "config"
  return "source"
}

export interface SummaryArea {
  readonly name: string
  readonly files: number
}

export interface Summary {
  readonly files: number
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly added: number
  readonly deleted: number
  readonly modified: number
  readonly conflicts: number
  readonly additions: number
  readonly deletions: number
  readonly areas: readonly SummaryArea[]
}

export function summarize(items: readonly Item[], stats: readonly Stat[]): Summary {
  const rest = items.filter((item) => !isConflicted(item.code))
  const count = (status: Item["status"]) => rest.filter((item) => item.status === status).length
  const areas = items.reduce(
    (map, item) => map.set(area(item.file), (map.get(area(item.file)) ?? 0) + 1),
    new Map<string, number>(),
  )
  return {
    files: items.length,
    staged: items.filter((item) => isStaged(item.code)).length,
    unstaged: items.filter((item) => isUnstaged(item.code)).length,
    untracked: items.filter((item) => isUntracked(item.code)).length,
    added: count("added"),
    deleted: count("deleted"),
    modified: count("modified"),
    conflicts: items.filter((item) => isConflicted(item.code)).length,
    additions: stats.reduce((total, stat) => total + stat.additions, 0),
    deletions: stats.reduce((total, stat) => total + stat.deletions, 0),
    areas: [...areas]
      .map(([name, files]) => ({ name, files }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
  }
}

export interface MessageSuggestion {
  readonly type: string
  readonly scope?: string
  readonly subject: string
  readonly message: string
  readonly rationale: string
}

export function suggestMessage(items: readonly Item[], stats: readonly Stat[]): MessageSuggestion | undefined {
  if (items.length === 0) return undefined
  const changes = items.filter((item) => !isConflicted(item.code))
  if (changes.length === 0) {
    return {
      type: "chore",
      subject: "resolve merge conflicts",
      message: "chore: resolve merge conflicts",
      rationale: "Every reported change is an unresolved merge conflict.",
    }
  }

  const kinds = new Set(changes.map((item) => classify(item.file)))
  const only = (allowed: readonly FileKind[]) => [...kinds].every((kind) => allowed.includes(kind))
  const additions = stats.reduce((total, stat) => total + stat.additions, 0)
  const deletions = stats.reduce((total, stat) => total + stat.deletions, 0)
  const type = only(["docs"])
    ? "docs"
    : only(["test", "docs"])
      ? "test"
      : only(["config", "schema"])
        ? "chore"
        : changes.every((item) => item.status === "deleted")
          ? "refactor"
          : additions < deletions && changes.some((item) => item.status !== "added")
            ? "refactor"
            : "feat"

  const areas = new Set(changes.map((item) => area(item.file)))
  const scope = areas.size === 1 && [...areas][0] !== "." ? [...areas][0] : undefined
  const totals = new Map(stats.map((stat) => [stat.file, stat.additions + stat.deletions]))
  const primary = [...changes].sort((a, b) => (totals.get(b.file) ?? 0) - (totals.get(a.file) ?? 0))[0]
  const name = (unix(primary.file).split("/").pop() ?? primary.file)
    .replace(/\.[^.]*$/, "")
    .replace(/\.(test|spec)$/, "")
  const verb = changes.every((item) => item.status === "added")
    ? "add"
    : changes.every((item) => item.status === "deleted")
      ? "remove"
      : "update"
  const subject =
    changes.length === 1 ? `${verb} ${name}` : `${verb} ${name} and ${changes.length - 1} more file${changes.length === 2 ? "" : "s"}`
  return {
    type,
    scope,
    subject,
    message: `${type}${scope ? `(${scope})` : ""}: ${subject}`.slice(0, 100),
    rationale: `Basis: ${changes.length} change(s) (+${additions}/-${deletions}) touching ${[...kinds].sort().join(", ")} files; type inferred from those kinds and the change direction, so refine it when the intent differs.`,
  }
}

export interface BranchSuggestion {
  readonly name: string
  readonly creating: boolean
  readonly reason: string
}

const filler = new Set(["and", "more", "file", "files", "the", "a", "an", "to", "of", "for", "update", "updates", "work"])

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function suggestBranch(input: {
  items: readonly Item[]
  stats: readonly Stat[]
  current?: string
  defaultBranch?: string
  task?: string
}): BranchSuggestion | undefined {
  const isDefault =
    input.current !== undefined
      ? input.defaultBranch !== undefined
        ? input.current === input.defaultBranch
        : input.current === "main" || input.current === "master"
      : true
  if (input.current && !isDefault) {
    return {
      name: input.current,
      creating: false,
      reason: `Already on "${input.current}", which is not the default branch.`,
    }
  }
  const suggestion = suggestMessage(input.items, input.stats)
  const source = input.task?.trim() || suggestion?.subject
  if (!source) return undefined
  const words = slugify(source)
    .split("-")
    .filter((word) => word && !filler.has(word) && !/^\d+$/.test(word))
    .slice(0, 3)
  if (words.length === 0) return undefined
  const name = [...(suggestion?.scope ? [slugify(suggestion.scope)] : []), ...words]
    .join("-")
    .slice(0, 50)
    .replace(/-+$/g, "")
  return {
    name,
    creating: true,
    reason:
      input.current && isDefault
        ? `"${input.current}" is the default branch; park this work on a topic branch instead.`
        : input.task
          ? "Derived from the task description."
          : "Derived from the current changes.",
  }
}

export interface ConflictExplanation {
  readonly file: string
  readonly regions: number
  readonly ours: number
  readonly theirs: number
  readonly labels: readonly string[]
  readonly note: string
}

export function explainConflict(file: string, content: string | undefined): ConflictExplanation {
  if (content === undefined) {
    return {
      file,
      regions: 0,
      ours: 0,
      theirs: 0,
      labels: [],
      note: "could not be read (binary or removed); choose a side with git checkout --ours/--theirs or drop it with git rm",
    }
  }
  let regions = 0
  let ours = 0
  let theirs = 0
  let side: "ours" | "base" | "theirs" | undefined
  const labels = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    if (/^<{7}(\s|$)/.test(line)) {
      regions += 1
      side = "ours"
      const label = line.slice(7).trim()
      if (label) labels.add(label)
      continue
    }
    if (/^\|{7}(\s|$)/.test(line)) {
      side = "base"
      continue
    }
    if (/^={7}\s*$/.test(line)) {
      side = "theirs"
      continue
    }
    if (/^>{7}(\s|$)/.test(line)) {
      side = undefined
      const label = line.slice(7).trim()
      if (label) labels.add(label)
      continue
    }
    if (side === "ours") ours += 1
    if (side === "theirs") theirs += 1
  }
  return {
    file,
    regions,
    ours,
    theirs,
    labels: [...labels],
    note:
      regions === 0
        ? "no conflict markers found; the conflict is structural (added/deleted/renamed file), so choose a side with git checkout --ours/--theirs or drop it with git rm"
        : `${regions} conflicted region(s); edit the file, then stage the resolution with git add`,
  }
}

export type SignalLevel = "high" | "medium" | "low"

export interface Signal {
  readonly level: SignalLevel
  readonly message: string
}

const levels: Record<SignalLevel, number> = { high: 0, medium: 1, low: 2 }

export function regressionSignals(items: readonly Item[], stats: readonly Stat[]): readonly Signal[] {
  const byFile = new Map(stats.map((stat) => [stat.file, stat]))
  const signals = items.flatMap((item): Signal[] => {
    const kind = classify(item.file)
    const stat = byFile.get(item.file)
    if (kind === "test" && item.status === "deleted")
      return [{ level: "high", message: `test removed: ${item.file} — the behaviour it covered is unverified until replaced` }]
    if (kind === "test") return [{ level: "low", message: `test changed: ${item.file} — run the suite before merging` }]
    if (kind === "schema")
      return [{ level: "high", message: `schema or migration changed: ${item.file} — verify data compatibility and rollback` }]
    if (kind === "config")
      return [{ level: "medium", message: `configuration or lockfile changed: ${item.file} — verify tooling and dependency behaviour` }]
    if (item.status === "deleted")
      return [{ level: "medium", message: `file removed: ${item.file} — check for callers or imports left behind` }]
    if (stat && stat.deletions >= 200)
      return [
        {
          level: "medium",
          message: `large deletion in ${item.file} (${stat.deletions} lines) — confirm the removed behaviour is not still required`,
        },
      ]
    return []
  })
  return signals.sort((a, b) => levels[a.level] - levels[b.level] || a.message.localeCompare(b.message))
}

export interface MergePlan {
  readonly target: string
  readonly blocked: boolean
  readonly likelyConflicts: readonly string[]
  readonly steps: readonly string[]
  readonly notes: readonly string[]
}

export function mergePlan(input: {
  current?: string
  target: string
  dirty: boolean
  ours: readonly string[]
  theirs: readonly string[]
  mergeBase?: string
}): MergePlan {
  const theirs = new Set(input.theirs)
  const likelyConflicts = input.ours.filter((file) => theirs.has(file))
  const blocked = input.dirty || input.current === undefined || input.mergeBase === undefined
  const steps = blocked
    ? [
        input.dirty
          ? "Commit or stash the working tree first: git status"
          : input.current === undefined
            ? "Check out a branch first: the repository is on a detached HEAD"
            : `Fetch the target branch and retry: git fetch && git merge-base ${input.target} HEAD`,
      ]
    : [
        "git fetch",
        `git merge ${input.target}`,
        ...(likelyConflicts.length
          ? [`Resolve ${likelyConflicts.length} likely conflict(s): ${likelyConflicts.slice(0, 10).join(", ")}`, 'Use the git tool action "conflicts" for a per-file explanation']
          : []),
        "Run the tests and build before committing the merge",
        "Push manually when the result is verified",
      ]
  return {
    target: input.target,
    blocked,
    likelyConflicts,
    steps,
    notes: [
      "Advisory only: nothing is merged, committed or pushed automatically.",
      likelyConflicts.length
        ? `${likelyConflicts.length} path(s) changed on both sides since ${input.mergeBase ? input.mergeBase.slice(0, 12) : "the merge base"}, so conflicts are likely there.`
        : "No overlapping files detected between the two sides.",
      "Recover with git merge --abort at any point before committing.",
    ],
  }
}

export interface CommitEntry {
  readonly hash: string
  readonly subject: string
}

export interface PullRequestDraft {
  readonly title: string
  readonly body: string
  readonly commands: readonly string[]
}

export function preparePR(input: {
  base: string
  branch: string
  commits: readonly CommitEntry[]
  items: readonly Item[]
  stats: readonly Stat[]
  signals: readonly Signal[]
}): PullRequestDraft | undefined {
  if (input.commits.length === 0 && input.items.length === 0) return undefined
  const suggestion = suggestMessage(input.items, input.stats)
  const title =
    input.commits.length === 1
      ? input.commits[0].subject
      : (suggestion?.message ?? `update ${input.branch}`)
  const additions = input.stats.reduce((total, stat) => total + stat.additions, 0)
  const deletions = input.stats.reduce((total, stat) => total + stat.deletions, 0)
  const areas = summarize(input.items, input.stats).areas
  const tests = input.items.filter((item) => classify(item.file) === "test").map((item) => item.file)
  const body = [
    "## Summary",
    `- ${input.commits.length} commit(s) on \`${input.branch}\` ahead of \`${input.base}\``,
    `- ${input.items.length} file(s) changed (+${additions}/-${deletions})`,
    "",
    "## Commits",
    ...(input.commits.length
      ? input.commits.slice(0, 20).map((commit) => `- ${commit.hash} ${commit.subject}`)
      : ["- No commits yet; commit the working tree first."]),
    ...(input.commits.length > 20 ? [`- …and ${input.commits.length - 20} more`] : []),
    "",
    "## Changes by area",
    ...(areas.length ? areas.map((entry) => `- ${entry.name}: ${entry.files} file(s)`) : ["- No file changes detected."]),
    "",
    "## Risk notes",
    ...(input.signals.length
      ? input.signals.map((signal) => `- [${signal.level}] ${signal.message}`)
      : ["- No regression signals detected; run the tests anyway."]),
    "",
    "## Test plan",
    ...(tests.length ? [`- Updated tests: ${tests.slice(0, 10).join(", ")}`] : ["- No test changes in this branch; verify manually."]),
  ].join("\n")
  return {
    title,
    body,
    commands: [
      `git push --set-upstream origin ${input.branch}`,
      `gh pr create --base ${input.base} --title ${JSON.stringify(title)} --body "<paste the body above>"`,
    ],
  }
}

export * as GitIntelligence from "./intelligence"
