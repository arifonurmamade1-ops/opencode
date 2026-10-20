import { describe, expect, test } from "bun:test"
import { AutonomousTask } from "@/autonomous/task"

const now = 1_000

function newTask() {
  return AutonomousTask.create({
    id: "atk_test",
    sessionID: "ses_test",
    objective: "Add complete authentication",
    acceptance: ["A user can sign in with a valid password", "Invalid passwords are rejected"],
    now,
  })
}

function mark(task: AutonomousTask.Info, stage: AutonomousTask.Stage, evidence = [`${stage}: verified`]) {
  const result = AutonomousTask.update(task, {
    stage,
    status: "done",
    evidence,
    now: now + 1,
  })
  if (!result.ok) throw new Error(result.error)
  return result.task
}

function markAll(task: AutonomousTask.Info, skipped: AutonomousTask.Stage[] = []) {
  return AutonomousTask.Stages.reduce((current, stage) => {
    if (stage === "artifact") return current
    if (skipped.includes(stage)) {
      const result = AutonomousTask.update(current, {
        stage,
        status: "skipped",
        reason: `${stage} does not apply to this task`,
        now: now + 1,
      })
      if (!result.ok) throw new Error(result.error)
      return result.task
    }
    return mark(current, stage)
  }, task)
}

describe("autonomous task state", () => {
  test("starts every stage pending with the objective and acceptance criteria", () => {
    const task = newTask()

    expect(task.status).toBe("active")
    expect(task.objective).toBe("Add complete authentication")
    expect(task.acceptance).toHaveLength(2)
    for (const stage of AutonomousTask.Stages) expect(task.stages[stage].status).toBe("pending")
    expect(AutonomousTask.nextStage(task)).toBe("understand")
  })

  test("requires evidence before a stage can be done", () => {
    const result = AutonomousTask.update(newTask(), {
      stage: "understand",
      status: "done",
      now: now + 1,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("without evidence")
  })

  test("requires a reason before a stage can be skipped", () => {
    const result = AutonomousTask.update(newTask(), {
      stage: "browser",
      status: "skipped",
      now: now + 1,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("requires a reason")
  })

  test("delivery is gated on required stages and unresolved work", () => {
    let task = newTask()
    task = mark(task, "understand")
    expect(AutonomousTask.deliveryProblems(task)).toContain("plan: pending (must be done or skipped)")

    task = markAll(task)
    expect(AutonomousTask.deliveryProblems(task)).toEqual([])

    const delivered = AutonomousTask.markDelivered(task, "/tmp/auth.md", now + 2)
    expect(delivered.status).toBe("delivered")
    expect(delivered.stages.artifact.status).toBe("done")
    expect(delivered.stages.artifact.evidence).toContain("/tmp/auth.md")
    expect(AutonomousTask.deliveryProblems(delivered)).toEqual([])
  })

  test("a required stage cannot be skipped", () => {
    const task = markAll(newTask(), ["security"])

    expect(AutonomousTask.deliveryProblems(task)).toContain("security: required before delivery and cannot be skipped")
  })

  test("a blocker stops delivery and can be resolved", () => {
    let task = markAll(newTask())
    const blocked = AutonomousTask.block(task, {
      stage: "test",
      what: "Integration tests need a database",
      why: "No database URL is configured in the environment",
      needs: ["Set TEST_DATABASE_URL"],
      now: now + 2,
    })
    expect(blocked.ok).toBe(true)
    if (!blocked.ok) return
    task = blocked.task

    expect(task.status).toBe("blocked")
    expect(task.blocker?.stage).toBe("test")
    expect(AutonomousTask.deliveryProblems(task)).toContain("blocker: Integration tests need a database")

    const text = AutonomousTask.render(task)
    expect(text).toContain("Status: BLOCKED")
    expect(text).toContain("BLOCKED")
    expect(text).toContain("WHAT: Integration tests need a database")
    expect(text).toContain("WHY: No database URL is configured")
    expect(text).toContain("NEEDED:")
    expect(text).toContain("Set TEST_DATABASE_URL")

    const resolved = AutonomousTask.update(task, {
      stage: "test",
      status: "done",
      evidence: ["bun test test/auth.test.ts: 12 passed"],
      now: now + 3,
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.task.status).toBe("active")
      expect(resolved.task.blocker).toBeUndefined()
    }
  })

  test("renders the evidence trail and stage checklist", () => {
    const task = mark(newTask(), "understand", ["Acceptance criteria mapped to src/auth.ts"])
    const text = AutonomousTask.render(task, "/tmp/artifact.md")

    expect(text).toContain("[x] understand - done")
    expect(text).toContain("evidence: Acceptance criteria mapped to src/auth.ts")
    expect(text).toContain("[ ] plan - pending")
    expect(text).toContain("- A user can sign in with a valid password")
    expect(text).toContain("Artifact: /tmp/artifact.md")
  })
})
