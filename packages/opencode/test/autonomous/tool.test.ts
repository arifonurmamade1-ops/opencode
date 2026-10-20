import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { AutonomousTaskTool } from "@/tool/autonomous"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([FSUtil.node, Truncate.node, Agent.node]))
const it = testEffect(layer)

function makeCtx() {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "autonomous",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  } satisfies Tool.Context
}

describe("autonomous_task tool", () => {
  it.instance(
    "enforces evidence gates and writes the delivery artifact",
    () =>
      Effect.gen(function* () {
        const info = yield* AutonomousTaskTool
        const tool = yield* Tool.init(info)
        const ctx = makeCtx()

        const empty = yield* tool.execute({ action: "start", objective: "Add authentication", acceptance: [] }, ctx)
        expect(empty.output).toContain("at least one acceptance criterion")

        const started = yield* tool.execute(
          {
            action: "start",
            objective: "Add authentication",
            acceptance: ["Users can sign in", "Invalid passwords are rejected"],
          },
          ctx,
        )
        const task = started.metadata.task
        if (!task) throw new Error("start did not create a task")
        expect(task.status).toBe("active")

        const noEvidence = yield* tool.execute({ action: "update", stage: "understand", stageStatus: "done" }, ctx)
        expect(noEvidence.output).toContain("without evidence")

        const notReady = yield* tool.execute({ action: "deliver" }, ctx)
        expect(notReady.output).toContain("DELIVERY BLOCKED")
        expect(notReady.metadata.problems).toContain("understand: pending (must be done or skipped)")

        for (const stage of [
          "understand",
          "research",
          "plan",
          "agents",
          "implement",
          "run",
          "test",
          "browser",
          "fix",
          "security",
          "diff",
        ] as const) {
          const result = yield* tool.execute(
            {
              action: "update",
              stage,
              stageStatus: "done",
              evidence: [`${stage}: command and result recorded`],
            },
            ctx,
          )
          expect(result.metadata.task?.stages[stage].status).toBe("done")
        }

        const delivered = yield* tool.execute({ action: "deliver" }, ctx)
        expect(delivered.output).toContain("DELIVERED")
        expect(delivered.metadata.task?.status).toBe("delivered")
        const artifactPath = delivered.metadata.artifactPath
        if (!artifactPath) throw new Error("deliver did not return an artifact path")

        const test = yield* TestInstance
        expect(artifactPath.startsWith(test.directory)).toBe(true)
        const artifact = yield* Effect.promise(() => Bun.file(artifactPath).text())
        expect(artifact).toContain("Status: DELIVERED")
        expect(artifact).toContain("evidence: security: command and result recorded")

        const status = yield* tool.execute({ action: "status" }, ctx)
        expect(status.output).toContain("Status: DELIVERED")
      }),
    30000,
  )

  it.instance(
    "records a blocker and writes a BLOCKED artifact",
    () =>
      Effect.gen(function* () {
        const info = yield* AutonomousTaskTool
        const tool = yield* Tool.init(info)
        const ctx = makeCtx()

        yield* tool.execute(
          {
            action: "start",
            objective: "Deploy the service",
            acceptance: ["The service responds on the public URL"],
          },
          ctx,
        )

        const blocked = yield* tool.execute(
          {
            action: "block",
            stage: "run",
            what: "The deployment requires production credentials",
            why: "No production credentials are available in this environment",
            needs: ["Provide DEPLOY_TOKEN", "Confirm the target environment"],
          },
          ctx,
        )

        expect(blocked.output.startsWith("BLOCKED")).toBe(true)
        expect(blocked.output).toContain("WHAT: The deployment requires production credentials")
        expect(blocked.metadata.task?.status).toBe("blocked")
        const artifactPath = blocked.metadata.artifactPath
        if (!artifactPath) throw new Error("block did not return an artifact path")
        const artifact = yield* Effect.promise(() => Bun.file(artifactPath).text())
        expect(artifact).toContain("Status: BLOCKED")
        expect(artifact).toContain("NEEDED:")
        expect(artifact).toContain("Provide DEPLOY_TOKEN")
      }),
    30000,
  )
})
