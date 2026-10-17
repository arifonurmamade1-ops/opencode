import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { GitIntelligence } from "@/git/intelligence"
import { ShellID } from "./shell/id"
import DESCRIPTION from "./git.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "summary",
    "message",
    "branch",
    "smart",
    "conflicts",
    "merge",
    "regression",
    "pr",
  ]).annotate({ description: "What to analyze or do" }),
  base: Schema.optional(Schema.String).annotate({
    description: 'Target branch for "merge" and "pr". Defaults to the repository default branch.',
  }),
  task: Schema.optional(Schema.String).annotate({
    description: 'Short task description used when recommending a branch name (action="branch").',
  }),
  message: Schema.optional(Schema.String).annotate({
    description: 'Commit message override for action="smart".',
  }),
})

type Metadata = {
  action: string
  files: number
}

export const GitTool = Tool.define<typeof Parameters, Metadata, Git.Service | FSUtil.Service>(
  "git",
  Effect.gen(function* () {
    const git = yield* Git.Service
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const cwd = ins.worktree || ins.directory
          const [status, stats, branch, defaultBase] = yield* Effect.all([
            git.status(cwd),
            git.stats(cwd, "HEAD"),
            git.branch(cwd),
            git.defaultBranch(cwd),
          ])
          const meta = (files: number): Metadata => ({ action: params.action, files })

          switch (params.action) {
            case "summary": {
              const summary = GitIntelligence.summarize(status, stats)
              if (summary.files === 0)
                return {
                  title: "Working tree clean",
                  output: "No changes to summarize: the working tree is clean.",
                  metadata: meta(0),
                }
              const output = [
                `Branch: ${branch ?? "(detached HEAD)"}${defaultBase ? ` (default: ${defaultBase.name})` : ""}`,
                `${summary.files} changed file(s): ${summary.staged} staged, ${summary.unstaged} unstaged, ${summary.untracked} untracked${summary.conflicts ? `, ${summary.conflicts} conflicted` : ""}`,
                `Lines: +${summary.additions} / -${summary.deletions}`,
                `States: ${summary.added} added, ${summary.modified} modified, ${summary.deleted} deleted`,
                summary.areas.length
                  ? `Areas: ${summary.areas.map((entry) => `${entry.name} (${entry.files})`).join(", ")}`
                  : undefined,
                summary.conflicts ? `Resolve the ${summary.conflicts} conflicted file(s) first: action "conflicts" explains each one.` : undefined,
              ]
                .filter((line) => line !== undefined)
                .join("\n")
              return { title: `${summary.files} changed file(s)`, output, metadata: meta(summary.files) }
            }
            case "message": {
              const suggestion = GitIntelligence.suggestMessage(status, stats)
              if (!suggestion)
                return {
                  title: "No changes",
                  output: "No changes to describe: stage or edit files first.",
                  metadata: meta(0),
                }
              const output = [
                "Proposed commit message:",
                "",
                `    ${suggestion.message}`,
                "",
                suggestion.rationale,
                "Edit it before committing when the summary does not match the intent.",
              ].join("\n")
              return { title: suggestion.message, output, metadata: meta(status.length) }
            }
            case "branch": {
              const suggestion = GitIntelligence.suggestBranch({
                items: status,
                stats,
                current: branch,
                defaultBranch: defaultBase?.name,
                task: params.task,
              })
              if (!suggestion)
                return {
                  title: "No changes",
                  output: 'No changes and no task description; describe the task with "task" or edit files first.',
                  metadata: meta(0),
                }
              const output = suggestion.creating
                ? [`Recommended branch: ${suggestion.name}`, "", suggestion.reason, "", `    git switch -c ${suggestion.name}`, "", "Nothing is switched automatically."].join("\n")
                : [`Keep working on "${suggestion.name}".`, "", suggestion.reason].join("\n")
              return { title: `Branch: ${suggestion.name}`, output, metadata: meta(status.length) }
            }
            case "smart": {
              if (status.length === 0)
                return {
                  title: "Nothing to commit",
                  output: "Nothing to commit: the working tree is clean.",
                  metadata: meta(0),
                }
              const conflicts = status.filter((item) => GitIntelligence.isConflicted(item.code))
              if (conflicts.length)
                return {
                  title: "Conflicts unresolved",
                  output: `Unresolved conflicts in ${conflicts.length} file(s); resolve them first (action "conflicts" explains each one).`,
                  metadata: meta(conflicts.length),
                }
              if (!branch)
                return {
                  title: "Detached HEAD",
                  output: "Detached HEAD; check out a branch before committing.",
                  metadata: meta(status.length),
                }
              const suggestion = GitIntelligence.suggestMessage(status, stats)
              const message = params.message?.trim() || suggestion?.message || "chore: update working tree"
              yield* ctx.ask({
                permission: ShellID.ToolID,
                patterns: ["git add *", "git commit *"],
                always: ["git add *", "git commit *"],
                metadata: { command: `git add -A && git commit -m ${JSON.stringify(message)}`, cwd: ins.directory },
              })
              const add = yield* git.run(["add", "-A", "--", "."], { cwd })
              if (add.exitCode !== 0)
                return { title: "git add failed", output: `git add failed:\n${stderr(add)}`, metadata: meta(status.length) }
              const commit = yield* git.run(["-c", "commit.gpgsign=false", "commit", "-m", message], { cwd })
              if (commit.exitCode !== 0)
                return { title: "git commit failed", output: `git commit failed:\n${stderr(commit)}`, metadata: meta(status.length) }
              const head = yield* git.run(["log", "-1", "--format=%h %s"], { cwd })
              const output = [
                `Committed ${head.text().trim()}`,
                `Staged and committed ${status.length} changed file(s) on "${branch}".`,
                defaultBase && branch === defaultBase.name
                  ? `Note: "${branch}" is the default branch; action "branch" suggests a topic branch for next time.`
                  : undefined,
                "",
                'Nothing was pushed. Use action "pr" to prepare the pull request, or push manually.',
              ]
                .filter((line) => line !== undefined)
                .join("\n")
              return { title: "Committed", output, metadata: meta(status.length) }
            }
            case "conflicts": {
              const conflicted = status.filter((item) => GitIntelligence.isConflicted(item.code))
              if (conflicted.length === 0)
                return {
                  title: "No conflicts",
                  output: 'No merge conflicts in the working tree. Use action "merge" to preview a merge against a target branch.',
                  metadata: meta(0),
                }
              const entries = yield* Effect.forEach(conflicted.slice(0, 20), (item) =>
                Effect.gen(function* () {
                  const content = yield* fs.readFileStringSafe(path.join(cwd, item.file))
                  return { code: item.code, explanation: GitIntelligence.explainConflict(item.file, content) }
                }),
              )
              const lines = entries.flatMap(({ code, explanation }) => [
                `${explanation.file} (${code}: ${GitIntelligence.describeConflict(code)})`,
                `  ${explanation.regions} conflict region(s); ${explanation.ours} line(s) from this branch vs ${explanation.theirs} line(s) from the incoming side`,
                ...(explanation.labels.length ? [`  markers: ${explanation.labels.join(", ")}`] : []),
                `  ${explanation.note}`,
                "",
              ])
              if (conflicted.length > 20) lines.push(`…and ${conflicted.length - 20} more conflicted file(s).`)
              return {
                title: `${conflicted.length} conflicted file(s)`,
                output: lines.join("\n").trim(),
                metadata: meta(conflicted.length),
              }
            }
            case "merge": {
              const target = params.base?.trim() || defaultBase?.name
              if (!target)
                return {
                  title: "No target",
                  output: 'No target branch: pass "base" or ensure a default branch exists.',
                  metadata: meta(status.length),
                }
              if (!branch)
                return {
                  title: "Detached HEAD",
                  output: "Detached HEAD; check out a branch before merging.",
                  metadata: meta(status.length),
                }
              if (target === branch)
                return {
                  title: "Already on target",
                  output: `Already on "${target}"; nothing to merge.`,
                  metadata: meta(status.length),
                }
              const [mergeBase, ours, theirs] = yield* Effect.all([
                git.mergeBase(cwd, target),
                git.diff(cwd, `${target}...HEAD`),
                git.diff(cwd, `HEAD...${target}`),
              ])
              const plan = GitIntelligence.mergePlan({
                current: branch,
                target,
                dirty: status.some((item) => !GitIntelligence.isUntracked(item.code)),
                ours: ours.map((item) => item.file),
                theirs: theirs.map((item) => item.file),
                mergeBase,
              })
              const output = [
                `Merge "${target}" into "${branch}"`,
                "",
                plan.blocked ? "Blocked:" : "Ready to merge:",
                ...plan.steps.map((step, index) => `  ${index + 1}. ${step}`),
                "",
                "Notes:",
                ...plan.notes.map((note) => `  - ${note}`),
              ].join("\n")
              return { title: plan.blocked ? "Blocked" : `Merge ${target}`, output, metadata: meta(status.length) }
            }
            case "regression": {
              const signals = GitIntelligence.regressionSignals(status, stats)
              if (signals.length === 0)
                return {
                  title: "No signals",
                  output: "No regression signals in the current changes. Run the test suite before merging anyway.",
                  metadata: meta(status.length),
                }
              const output = [
                `${signals.length} regression signal(s):`,
                "",
                ...signals.map((signal) => `- [${signal.level}] ${signal.message}`),
                "",
                "Signals are heuristics over the changed paths; they do not replace running the tests.",
              ].join("\n")
              return { title: `${signals.length} signal(s)`, output, metadata: meta(status.length) }
            }
            case "pr": {
              const target = params.base?.trim() || defaultBase?.name
              if (!target)
                return {
                  title: "No target",
                  output: 'No base branch: pass "base" or ensure a default branch exists.',
                  metadata: meta(status.length),
                }
              if (!branch)
                return {
                  title: "Detached HEAD",
                  output: "Detached HEAD; check out a branch before preparing a pull request.",
                  metadata: meta(status.length),
                }
              const mergeBase = yield* git.mergeBase(cwd, target)
              if (!mergeBase)
                return {
                  title: "No common ancestor",
                  output: `No common ancestor with "${target}"; fetch and try again.`,
                  metadata: meta(status.length),
                }
              const [log, files, prStats] = yield* Effect.all([
                git.run(["log", "--format=%h\t%s", `${mergeBase}..HEAD`], { cwd }),
                git.diff(cwd, `${target}...HEAD`),
                git.stats(cwd, `${target}...HEAD`),
              ])
              const commits = log
                .text()
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .flatMap((line) => {
                  const tab = line.indexOf("\t")
                  if (tab <= 0) return []
                  return [{ hash: line.slice(0, tab), subject: line.slice(tab + 1) }]
                })
              const draft = GitIntelligence.preparePR({
                base: target,
                branch,
                commits,
                items: files,
                stats: prStats,
                signals: GitIntelligence.regressionSignals(files, prStats),
              })
              if (!draft)
                return {
                  title: "Nothing to prepare",
                  output: `No commits or changes ahead of "${target}".`,
                  metadata: meta(status.length),
                }
              const output = [
                `Pull request draft (against "${target}")`,
                "",
                `Title: ${draft.title}`,
                "",
                draft.body,
                "",
                "Publish manually:",
                ...draft.commands.map((command) => `    ${command}`),
                "",
                "opencode never pushes or opens the pull request automatically.",
              ].join("\n")
              return { title: draft.title, output, metadata: meta(commits.length) }
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const stderr = (result: { stderr: Buffer }) =>
  result.stderr.toString("utf8").trim().split(/\r?\n/).slice(0, 4).join("\n") || "unknown error"
