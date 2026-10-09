import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Effect } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectDocs } from "@opencode-ai/core/system-context/docs-context"

const runResult = (stdout: string, exitCode = 0): AppProcess.RunResult => ({
  command: "git ls-files",
  exitCode,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  outputTruncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
})

interface FakeDeps {
  proc: AppProcess.Interface
  directory: AbsolutePath
}

const deps = (proc: AppProcess.Interface): FakeDeps => ({
  proc,
  directory: AbsolutePath.make("/repo"),
})

const proc = (run: AppProcess.Interface["run"]): AppProcess.Interface =>
  ({ run, runStream: () => Effect.die("unreachable") } as unknown as AppProcess.Interface)

describe("ProjectDocs.parseDocs", () => {
  test("splits on newlines and drops blanks", () => {
    expect(ProjectDocs.parseDocs("README.md\nsrc/a.md\n\n")).toEqual(["README.md", "src/a.md"])
  })
})

describe("ProjectDocs.filterDocs", () => {
  test("keeps markdown and drops metadata + non-docs", () => {
    expect(
      ProjectDocs.filterDocs(["README.md", "src/a.md", "notes.txt", "node_modules/x.md", ".git/HEAD"]),
    ).toEqual(["README.md", "src/a.md"])
  })
})

describe("ProjectDocs.rankDocs", () => {
  test("ranks README and docs/ entries first (stable)", () => {
    const out = ProjectDocs.rankDocs(["src/a.md", "README.md", "docs/guide.md", "src/b.md"])
    expect(out[0]).toBe("README.md")
    expect(out).toContain("docs/guide.md")
    expect(out).toContain("src/a.md")
  })
})

describe("ProjectDocs.render", () => {
  test("renders a budgeted summary and empties to empty string", () => {
    const rendered = ProjectDocs.render(["README.md", "docs/api.md"])
    expect(rendered).toContain("Project docs")
    expect(rendered).toContain("README.md")
    expect(rendered).toContain("docs/api.md")
    expect(ProjectDocs.render([])).toBe("")
  })

  test("annotates truncation when the token budget trims the list", () => {
    const docs = Array.from({ length: 200 }, (_, i) => `docs/guide${i}.md`)
    expect(ProjectDocs.render(docs)).toContain("shown")
  })
})

describe("ProjectDocs.loadDocs", () => {
  test("filters+ranks git ls-files output on success", async () => {
    const docs = await Effect.runPromise(
      ProjectDocs.loadDocs(
        deps(proc(() => Effect.succeed(runResult("README.md\nsrc/a.ts\nsrc/guide.md\nnotes.txt\n")))),
      ),
    )
    expect(docs).toEqual(["README.md", "src/guide.md"])
  })

  test("returns [] on a non-git exit code", async () => {
    const docs = await Effect.runPromise(ProjectDocs.loadDocs(deps(proc(() => Effect.succeed(runResult("", 128))))))
    expect(docs).toEqual([])
  })

  test("returns [] when git is unavailable", async () => {
    const docs = await Effect.runPromise(
      ProjectDocs.loadDocs(deps(proc(() => Effect.fail(new AppProcess.AppProcessError({ command: "git ls-files" }))))),
    )
    expect(docs).toEqual([])
  })
})
