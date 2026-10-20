import { Schema } from "effect"

/**
 * Controlled autonomous task state.
 *
 * The state machine is intentionally pure: the tool layer owns persistence and
 * artifact writes, while these functions decide which transitions are legal and
 * whether a task may be delivered. Delivery is gated on evidence so a task can
 * report BLOCKED instead of silently claiming success.
 */

export const Stages = [
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
  "artifact",
] as const

export type Stage = (typeof Stages)[number]

export const StageStatus = Schema.Literals(["pending", "in_progress", "done", "skipped", "blocked"])
export type StageStatus = Schema.Schema.Type<typeof StageStatus>

export const UpdateStatus = Schema.Literals(["in_progress", "done", "skipped"])
export type UpdateStatus = Schema.Schema.Type<typeof UpdateStatus>

export const StageInfo = Schema.Struct({
  status: StageStatus,
  evidence: Schema.Array(Schema.String),
  reason: Schema.optional(Schema.String),
  updatedAt: Schema.Finite,
})
export type StageInfo = Schema.Schema.Type<typeof StageInfo>

const StageMap = Schema.Struct({
  understand: StageInfo,
  research: StageInfo,
  plan: StageInfo,
  agents: StageInfo,
  implement: StageInfo,
  run: StageInfo,
  test: StageInfo,
  browser: StageInfo,
  fix: StageInfo,
  security: StageInfo,
  diff: StageInfo,
  artifact: StageInfo,
})
export type StageMap = Schema.Schema.Type<typeof StageMap>

export const TaskStatus = Schema.Literals(["active", "blocked", "delivered"])
export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>

export const Blocker = Schema.Struct({
  stage: Schema.optional(Schema.String),
  what: Schema.String,
  why: Schema.String,
  needs: Schema.Array(Schema.String),
})
export type Blocker = Schema.Schema.Type<typeof Blocker>

export const Info = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  objective: Schema.String,
  acceptance: Schema.Array(Schema.String),
  status: TaskStatus,
  stages: StageMap,
  blocker: Schema.optional(Blocker),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  deliveredAt: Schema.optional(Schema.Finite),
  artifactPath: Schema.optional(Schema.String),
})
export type Info = Schema.Schema.Type<typeof Info>

/** Stages that must be completed, not skipped, before delivery. */
export const RequiredDone = ["understand", "plan", "implement", "test", "security", "diff"] as const

export const CreateInput = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  objective: Schema.String,
  acceptance: Schema.Array(Schema.String),
  now: Schema.Finite,
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export type UpdateInput = {
  stage: Stage
  status: UpdateStatus
  evidence?: readonly string[]
  reason?: string
  now: number
}

export type BlockInput = {
  stage: Stage
  what: string
  why: string
  needs?: readonly string[]
  evidence?: readonly string[]
  now: number
}

export type TransitionResult = { ok: true; task: Info } | { ok: false; error: string }

export function create(input: CreateInput): Info {
  return {
    id: input.id,
    sessionID: input.sessionID,
    objective: input.objective.trim(),
    acceptance: input.acceptance.map((item) => item.trim()).filter(Boolean),
    status: "active",
    stages: initialStages(input.now),
    createdAt: input.now,
    updatedAt: input.now,
  }
}

export function update(task: Info, input: UpdateInput): TransitionResult {
  if (task.status === "delivered") return { ok: false, error: "The task was already delivered." }

  const current = task.stages[input.stage]
  const evidence = [...current.evidence, ...clean(input.evidence)]
  if (input.status === "done" && evidence.length === 0) {
    return { ok: false, error: `Stage "${input.stage}" cannot be done without evidence.` }
  }
  const reason = cleanText(input.reason)
  if (input.status === "skipped" && !reason) {
    return { ok: false, error: `Stage "${input.stage}" requires a reason when marked skipped.` }
  }

  const stages: StageMap = {
    ...task.stages,
    [input.stage]: {
      status: input.status,
      evidence,
      reason: reason ?? current.reason,
      updatedAt: input.now,
    },
  }
  const blocked = Stages.some((stage) => stages[stage].status === "blocked")
  return {
    ok: true,
    task: {
      ...task,
      stages,
      status: blocked ? "blocked" : "active",
      blocker: blocked
        ? (task.blocker ?? {
            stage: input.stage,
            what: reason ?? `Stage "${input.stage}" remains blocked.`,
            why: reason ?? `Stage "${input.stage}" was previously blocked.`,
            needs: [],
          })
        : undefined,
      updatedAt: input.now,
    },
  }
}

export function block(task: Info, input: BlockInput): TransitionResult {
  if (task.status === "delivered") return { ok: false, error: "The task was already delivered." }
  if (!input.what.trim() || !input.why.trim()) return { ok: false, error: "A blocker requires both what and why." }

  const current = task.stages[input.stage]
  const stages: StageMap = {
    ...task.stages,
    [input.stage]: {
      status: "blocked",
      evidence: [...current.evidence, ...clean(input.evidence)],
      reason: input.what.trim(),
      updatedAt: input.now,
    },
  }
  return {
    ok: true,
    task: {
      ...task,
      stages,
      status: "blocked",
      blocker: {
        stage: input.stage,
        what: input.what.trim(),
        why: input.why.trim(),
        needs: clean(input.needs),
      },
      updatedAt: input.now,
    },
  }
}

/** Returns the reasons a task is not ready for delivery. Empty means ready. */
export function deliveryProblems(task: Info): string[] {
  if (task.status === "delivered") return []
  const problems: string[] = []
  for (const stage of Stages) {
    if (stage === "artifact") continue
    const state = task.stages[stage]
    if (state.status !== "done" && state.status !== "skipped") {
      problems.push(`${stage}: ${state.status} (must be done or skipped)`)
    }
  }
  for (const stage of RequiredDone) {
    if (task.stages[stage].status === "skipped") {
      problems.push(`${stage}: required before delivery and cannot be skipped`)
    }
  }
  if (task.blocker) problems.push(`blocker: ${task.blocker.what}`)
  return problems
}

export function markDelivered(task: Info, artifactPath: string, now: number): Info {
  return {
    ...task,
    stages: {
      ...task.stages,
      artifact: {
        status: "done",
        evidence: [...task.stages.artifact.evidence, artifactPath],
        updatedAt: now,
      },
    },
    status: "delivered",
    blocker: undefined,
    artifactPath,
    deliveredAt: now,
    updatedAt: now,
  }
}

export function nextStage(task: Info): Stage | undefined {
  return Stages.find((stage) => task.stages[stage].status !== "done" && task.stages[stage].status !== "skipped")
}

export function render(task: Info, artifactPath?: string): string {
  const lines = [
    `AUTONOMOUS TASK ${task.id}`,
    `Status: ${task.status.toUpperCase()}`,
    `Objective: ${task.objective}`,
    "",
    "Acceptance criteria:",
    ...task.acceptance.map((item) => `- ${item}`),
    "",
    "Stages:",
  ]
  for (const stage of Stages) {
    const state = task.stages[stage]
    lines.push(`${marker(state.status)} ${stage} - ${state.status}`)
    for (const item of state.evidence) lines.push(`    evidence: ${item}`)
    if (state.reason) lines.push(`    reason: ${state.reason}`)
  }

  if (task.blocker) {
    lines.push("", "BLOCKED", `WHAT: ${task.blocker.what}`, `WHY: ${task.blocker.why}`, "NEEDED:")
    if (task.blocker.needs.length === 0) lines.push("- Resolve the blocker described above.")
    else lines.push(...task.blocker.needs.map((item) => `- ${item}`))
  }

  const path = artifactPath ?? task.artifactPath
  if (path) lines.push("", `Artifact: ${path}`)
  if (task.deliveredAt !== undefined) lines.push(`Delivered: ${new Date(task.deliveredAt).toISOString()}`)
  return lines.join("\n")
}

function initialStages(now: number): StageMap {
  const stage = (): StageInfo => ({ status: "pending", evidence: [], updatedAt: now })
  return {
    understand: stage(),
    research: stage(),
    plan: stage(),
    agents: stage(),
    implement: stage(),
    run: stage(),
    test: stage(),
    browser: stage(),
    fix: stage(),
    security: stage(),
    diff: stage(),
    artifact: stage(),
  }
}

function marker(status: StageStatus) {
  if (status === "done") return "[x]"
  if (status === "skipped") return "[-]"
  if (status === "in_progress") return "[~]"
  if (status === "blocked") return "[!]"
  return "[ ]"
}

function clean(values?: readonly string[]) {
  return (values ?? []).map((item) => item.trim()).filter(Boolean)
}

function cleanText(value?: string) {
  const text = value?.trim()
  return text ? text : undefined
}

export * as AutonomousTask from "./task"
