// The version probe is used by installers, updaters, and health checks. Keep
// it on the small bootstrap entrypoint so it never pays for the command graph.
import { describe, expect, test } from "bun:test"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { join } from "node:path"

const packageDir = join(import.meta.dir, "..", "..")
const repoRoot = join(packageDir, "..", "..")
const entry = join(packageDir, "src", "index.ts")

async function run(flag: string) {
  const started = performance.now()
  const proc = Bun.spawn([process.execPath, entry, flag], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode, elapsed: performance.now() - started }
}

describe("cli startup", () => {
  for (const flag of ["--version", "-v"]) {
    test(`${flag} exits without loading the full CLI`, async () => {
      const result = await run(flag)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout.trim()).toBe(InstallationVersion)
      // The old entrypoint initialized every command and took tens of
      // seconds on cold machines. This is intentionally loose enough for a
      // busy CI runner while still catching a return to the full graph.
      expect(result.elapsed).toBeLessThan(15_000)
    }, 30_000)
  }
})
