import { describe, expect, test } from "bun:test"
import {
  activeAgents,
  activeCount,
  agentState,
  buildPanels,
  tokenTotal,
  type SessionLike,
  type StatusLike,
} from "./dashboard-model"

const session = (input: Partial<SessionLike> & { id: string }): SessionLike => ({
  directory: "/workspace",
  time: { created: 0, updated: 0 },
  ...input,
})

describe("dashboard panels", () => {
  test("lists every panel in a stable order", () => {
    const panels = buildPanels()
    expect(panels.map((panel) => panel.id)).toEqual([
      "projects",
      "agents",
      "tasks",
      "artifacts",
      "terminal",
      "browser",
      "files",
      "git",
      "tests",
      "logs",
      "models",
      "providers",
      "memory",
      "settings",
    ])
    expect(panels.map((panel) => panel.order)).toEqual(panels.map((_, index) => index))
  })

  test("classifies panels as data, action, or unavailable", () => {
    const byID = new Map(buildPanels().map((panel) => [panel.id, panel]))
    for (const id of ["projects", "agents", "models", "providers"] as const) expect(byID.get(id)?.kind).toBe("data")
    expect(byID.get("settings")?.kind).toBe("action")
    for (const id of ["tasks", "artifacts", "browser", "tests", "logs", "terminal", "files", "git", "memory"] as const)
      expect(byID.get(id)?.kind).toBe("unavailable")
  })

  test("only unavailable panels carry a reason, never a placeholder", () => {
    for (const panel of buildPanels()) {
      if (panel.kind === "unavailable") expect(panel.reasonKey).toBeTruthy()
      else expect(panel.reasonKey).toBeUndefined()
    }
  })

  test("attaches counts only to data panels that have them", () => {
    const byID = new Map(buildPanels({ projects: 3, providers: 2, models: 0 }).map((panel) => [panel.id, panel]))
    expect(byID.get("projects")?.count).toBe(3)
    expect(byID.get("providers")?.count).toBe(2)
    expect(byID.get("models")?.count).toBe(0)
    expect(byID.get("agents")?.count).toBeUndefined()
    expect(byID.get("projects")?.reasonKey).toBeUndefined()
  })
})

describe("agent state", () => {
  test("maps session status to agent state", () => {
    expect(agentState({ type: "busy" })).toBe("busy")
    expect(agentState({ type: "retry" })).toBe("retry")
    expect(agentState({ type: "idle" })).toBe("idle")
    expect(agentState(undefined)).toBe("idle")
  })

  test("sums every token bucket", () => {
    expect(tokenTotal({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } })).toBe(15)
    expect(tokenTotal(undefined)).toBeUndefined()
  })
})

describe("active agents", () => {
  const statuses: Record<string, StatusLike> = {
    ses_busy: { type: "busy" },
    ses_retry: { type: "retry" },
    ses_idle: { type: "idle" },
  }
  const status = (id: string) => statuses[id]

  test("orders active sessions before idle ones, newest first within a group", () => {
    const agents = activeAgents({
      sessions: [
        session({ id: "ses_idle", title: "Idle", time: { created: 0, updated: 100 } }),
        session({ id: "ses_busy", title: "Busy", time: { created: 0, updated: 10 } }),
        session({ id: "ses_retry", title: "Retry", time: { created: 0, updated: 20 } }),
      ],
      status,
    })
    expect(agents.map((agent) => agent.sessionID)).toEqual(["ses_busy", "ses_retry", "ses_idle"])
  })

  test("surfaces model, cost and tokens when the session has them", () => {
    const [agent] = activeAgents({
      sessions: [
        session({
          id: "ses_busy",
          title: "Busy",
          model: { providerID: "anthropic", id: "claude" },
          cost: 0.42,
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
        }),
      ],
      status,
    })
    expect(agent).toMatchObject({
      sessionID: "ses_busy",
      title: "Busy",
      state: "busy",
      model: "anthropic/claude",
      cost: 0.42,
      tokens: 15,
    })
  })

  test("never invents fields the backing data lacks", () => {
    const [agent] = activeAgents({ sessions: [session({ id: "ses_idle" })], status })
    expect(agent).toEqual({
      sessionID: "ses_idle",
      title: "ses_idle",
      directory: "/workspace",
      state: "idle",
    })
  })

  test("counts only non-idle agents and honors the limit", () => {
    const agents = activeAgents({
      sessions: [session({ id: "ses_busy" }), session({ id: "ses_retry" }), session({ id: "ses_idle" })],
      status,
      limit: 2,
    })
    expect(agents).toHaveLength(2)
    expect(activeCount(agents)).toBe(2)
    expect(activeCount(activeAgents({ sessions: [session({ id: "ses_idle" })], status }))).toBe(0)
  })
})