import { describe, expect, test } from "bun:test"
import { GitIntelligence } from "../../src/git/intelligence"

const item = (file: string, code: string, status: "added" | "modified" | "deleted" = "modified") => ({ file, code, status })
const stat = (file: string, additions: number, deletions: number) => ({ file, additions, deletions })

describe("summarize", () => {
  test("counts staged, unstaged, untracked and conflicted changes", () => {
    const summary = GitIntelligence.summarize(
      [
        item("src/a.ts", " M"),
        item("src/b.ts", "M "),
        item("src/c.ts", "??", "added"),
        item("src/d.ts", "UU"),
        item("src/e.ts", "AM", "added"),
      ],
      [stat("src/a.ts", 3, 1), stat("src/b.ts", 1, 0)],
    )
    expect(summary.files).toBe(5)
    expect(summary.staged).toBe(2)
    expect(summary.unstaged).toBe(2)
    expect(summary.untracked).toBe(1)
    expect(summary.conflicts).toBe(1)
    expect(summary.added).toBe(2)
    expect(summary.additions).toBe(4)
    expect(summary.deletions).toBe(1)
  })

  test("groups files under their package or top-level area", () => {
    const summary = GitIntelligence.summarize(
      [
        item("packages/app/a.ts", " M"),
        item("packages/app/b.ts", " M"),
        item("packages/ui/c.ts", " M"),
        item("README.md", " M"),
      ],
      [],
    )
    expect(summary.areas).toEqual([
      { name: "app", files: 2 },
      { name: ".", files: 1 },
      { name: "ui", files: 1 },
    ])
  })
})

describe("suggestMessage", () => {
  test("returns undefined with nothing to describe", () => {
    expect(GitIntelligence.suggestMessage([], [])).toBeUndefined()
  })

  test("narrows the type from the touched files", () => {
    expect(GitIntelligence.suggestMessage([item("README.md", " M")], [stat("README.md", 2, 0)])?.type).toBe("docs")
    expect(GitIntelligence.suggestMessage([item("src/a.test.ts", " M")], [])?.type).toBe("test")
    expect(GitIntelligence.suggestMessage([item("bun.lock", " M")], [])?.type).toBe("chore")
  })

  test("uses a shared area as scope and the largest file in the subject", () => {
    const suggestion = GitIntelligence.suggestMessage(
      [item("packages/app/src/a.ts", " M"), item("packages/app/src/b.ts", " M")],
      [stat("packages/app/src/a.ts", 1, 0), stat("packages/app/src/b.ts", 40, 10)],
    )
    expect(suggestion?.scope).toBe("app")
    expect(suggestion?.message).toBe("feat(app): update b and 1 more file")
  })

  test("names new and removed work explicitly", () => {
    expect(GitIntelligence.suggestMessage([item("a.ts", "??", "added")], [])?.message).toBe("feat: add a")
    expect(GitIntelligence.suggestMessage([item("a.ts", "D ", "deleted")], [])?.type).toBe("refactor")
  })

  test("labels conflict-only states", () => {
    expect(GitIntelligence.suggestMessage([item("src/a.ts", "UU")], [])?.message).toBe("chore: resolve merge conflicts")
  })
})

describe("suggestBranch", () => {
  test("keeps a non-default branch", () => {
    const suggestion = GitIntelligence.suggestBranch({
      items: [item("src/a.ts", " M")],
      stats: [],
      current: "task-worktree",
      defaultBranch: "main",
    })
    expect(suggestion?.creating).toBe(false)
    expect(suggestion?.name).toBe("task-worktree")
  })

  test("proposes a topic branch when sitting on the default branch", () => {
    const suggestion = GitIntelligence.suggestBranch({
      items: [],
      stats: [],
      current: "main",
      defaultBranch: "main",
      task: "fix login redirect loop",
    })
    expect(suggestion?.creating).toBe(true)
    expect(suggestion?.name).toBe("fix-login-redirect")
  })

  test("returns undefined without changes or a task", () => {
    expect(
      GitIntelligence.suggestBranch({ items: [], stats: [], current: "main", defaultBranch: "main" }),
    ).toBeUndefined()
  })
})

describe("explainConflict", () => {
  test("counts regions and lines on each side", () => {
    const content = [
      "top",
      "<<<<<<< HEAD",
      "ours one",
      "ours two",
      "=======",
      "theirs one",
      ">>>>>>> feature/incoming",
      "middle",
      "<<<<<<< HEAD",
      "ours three",
      "||||||| base",
      "ancestor line",
      "=======",
      "theirs two",
      "theirs three",
      ">>>>>>> feature/incoming",
      "end",
    ].join("\n")
    const explanation = GitIntelligence.explainConflict("src/a.ts", content)
    expect(explanation.regions).toBe(2)
    expect(explanation.ours).toBe(3)
    expect(explanation.theirs).toBe(3)
    expect(explanation.labels).toEqual(["HEAD", "feature/incoming"])
  })

  test("falls back when there are no markers", () => {
    const explanation = GitIntelligence.explainConflict("src/a.ts", "plain text")
    expect(explanation.regions).toBe(0)
    expect(explanation.note).toContain("structural")
    expect(GitIntelligence.explainConflict("bin.dat", undefined).note).toContain("binary")
  })

  test("describes unmerged codes", () => {
    expect(GitIntelligence.describeConflict("UU")).toBe("modified by both sides")
    expect(GitIntelligence.describeConflict("DD")).toBe("deleted by both sides")
  })
})

describe("regressionSignals", () => {
  test("flags removed tests, schema edits and lockfile changes", () => {
    const signals = GitIntelligence.regressionSignals(
      [
        item("src/a.test.ts", "D ", "deleted"),
        item("migrations/001.sql", " M"),
        item("bun.lock", " M"),
        item("src/b.ts", " M"),
      ],
      [stat("src/b.ts", 10, 0)],
    )
    expect(signals.length).toBe(3)
    expect(signals.some((signal) => signal.level === "high" && signal.message.includes("test removed"))).toBe(true)
    expect(signals.some((signal) => signal.level === "high" && signal.message.includes("schema"))).toBe(true)
    expect(signals.some((signal) => signal.level === "medium" && signal.message.includes("lockfile"))).toBe(true)
  })

  test("stays quiet on a small source change", () => {
    expect(GitIntelligence.regressionSignals([item("src/a.ts", " M")], [stat("src/a.ts", 5, 2)])).toEqual([])
  })
})

describe("mergePlan", () => {
  test("blocks on a dirty tree", () => {
    const plan = GitIntelligence.mergePlan({
      current: "topic",
      target: "main",
      dirty: true,
      ours: [],
      theirs: [],
      mergeBase: "abc",
    })
    expect(plan.blocked).toBe(true)
    expect(plan.steps[0]).toContain("Commit or stash")
  })

  test("intersects both sides for likely conflicts", () => {
    const plan = GitIntelligence.mergePlan({
      current: "topic",
      target: "main",
      dirty: false,
      ours: ["a.ts", "b.ts"],
      theirs: ["b.ts", "c.ts"],
      mergeBase: "abc",
    })
    expect(plan.blocked).toBe(false)
    expect(plan.likelyConflicts).toEqual(["b.ts"])
    expect(plan.steps.some((step) => step.includes("git merge main"))).toBe(true)
    expect(plan.notes.some((note) => note.includes("--abort"))).toBe(true)
  })
})

describe("preparePR", () => {
  test("drafts a title, body and manual publish commands", () => {
    const draft = GitIntelligence.preparePR({
      base: "main",
      branch: "git-intelligence",
      commits: [{ hash: "abc1234", subject: "feat(opencode): add git tool" }],
      items: [item("src/tool/git.ts", "A ", "added")],
      stats: [stat("src/tool/git.ts", 120, 0)],
      signals: [],
    })
    expect(draft?.title).toBe("feat(opencode): add git tool")
    expect(draft?.body).toContain("## Summary")
    expect(draft?.body).toContain("abc1234")
    expect(draft?.body).toContain("No regression signals")
    expect(draft?.commands[0]).toContain("git push --set-upstream origin git-intelligence")
    expect(draft?.commands[1]).toContain("gh pr create --base main")
  })

  test("returns undefined with nothing to publish", () => {
    expect(
      GitIntelligence.preparePR({ base: "main", branch: "topic", commits: [], items: [], stats: [], signals: [] }),
    ).toBeUndefined()
  })
})
