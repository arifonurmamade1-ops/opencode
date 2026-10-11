/**
 * FASE 18 — agent-first dashboard model.
 *
 * Pure aggregation over data the app already has (servers, projects, sessions,
 * providers, models). Panels that have no backing data are reported as
 * unavailable with an explicit reason, and navigation-only entries as actions.
 * Nothing here fabricates a capability the build does not have.
 */

export type PanelID =
  | "projects"
  | "agents"
  | "tasks"
  | "artifacts"
  | "terminal"
  | "browser"
  | "files"
  | "git"
  | "tests"
  | "logs"
  | "models"
  | "providers"
  | "memory"
  | "settings"

export type PanelKind = "data" | "action" | "unavailable"

export interface Panel {
  readonly id: PanelID
  readonly kind: PanelKind
  /** Lower numbers sort first. */
  readonly order: number
  /** i18n key for the panel label. */
  readonly labelKey: string
  /** i18n key describing why the panel has no data, when unavailable. */
  readonly reasonKey?: string
  /** Primary metric shown on the panel, when it has data. */
  readonly count?: number
}

export type AgentState = "busy" | "retry" | "idle"

export interface AgentEntry {
  readonly sessionID: string
  readonly title: string
  readonly directory: string
  readonly state: AgentState
  readonly model?: string
  readonly cost?: number
  readonly tokens?: number
}

export interface SessionLike {
  readonly id: string
  readonly title?: string
  readonly directory: string
  readonly time: { readonly created: number; readonly updated: number }
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly cost?: number
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
}

export type StatusLike = { readonly type: string }

export const panelOrder: readonly PanelID[] = [
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
]

/** Panels rendered from data the app already reads. */
const dataPanels: ReadonlySet<PanelID> = new Set<PanelID>(["projects", "agents", "models", "providers"])

/** Panels that only navigate to an existing surface. */
const actionPanels: ReadonlySet<PanelID> = new Set<PanelID>(["settings"])

const reasonKeys: Partial<Record<PanelID, string>> = {
  terminal: "dashboard.panel.unavailable.terminal",
  files: "dashboard.panel.unavailable.files",
  git: "dashboard.panel.unavailable.git",
  memory: "dashboard.panel.unavailable.memory",
  tasks: "dashboard.panel.unavailable.phase",
  artifacts: "dashboard.panel.unavailable.phase",
  browser: "dashboard.panel.unavailable.phase",
  tests: "dashboard.panel.unavailable.phase",
  logs: "dashboard.panel.unavailable.phase",
}

const labelKeys: Record<PanelID, string> = {
  projects: "dashboard.panel.projects",
  agents: "dashboard.panel.agents",
  tasks: "dashboard.panel.tasks",
  artifacts: "dashboard.panel.artifacts",
  terminal: "dashboard.panel.terminal",
  browser: "dashboard.panel.browser",
  files: "dashboard.panel.files",
  git: "dashboard.panel.git",
  tests: "dashboard.panel.tests",
  logs: "dashboard.panel.logs",
  models: "dashboard.panel.models",
  providers: "dashboard.panel.providers",
  memory: "dashboard.panel.memory",
  settings: "dashboard.panel.settings",
}

export function buildPanels(counts: Partial<Record<PanelID, number>> = {}): Panel[] {
  return panelOrder.map((id, index) => {
    const kind: PanelKind = dataPanels.has(id) ? "data" : actionPanels.has(id) ? "action" : "unavailable"
    const count = kind === "data" ? counts[id] : undefined
    return {
      id,
      kind,
      order: index,
      labelKey: labelKeys[id],
      ...(kind === "unavailable" ? { reasonKey: reasonKeys[id] ?? "dashboard.panel.unavailable" } : {}),
      ...(count === undefined ? {} : { count }),
    }
  })
}

export function agentState(status: StatusLike | undefined): AgentState {
  if (status?.type === "busy") return "busy"
  if (status?.type === "retry") return "retry"
  return "idle"
}

export function tokenTotal(tokens: SessionLike["tokens"]): number | undefined {
  if (!tokens) return undefined
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/**
 * Derives the ACTIVE AGENTS view from real sessions. A session is "active" when
 * its status is not idle; active sessions sort before idle ones, then by most
 * recently updated. Fields the report asks for that have no backing data
 * (progress percentage, per-agent tool list, result) are omitted rather than
 * invented.
 */
export function activeAgents(input: {
  sessions: readonly SessionLike[]
  status: (sessionID: string) => StatusLike | undefined
  limit?: number
}): AgentEntry[] {
  const byID = new Map(input.sessions.map((session) => [session.id, session] as const))
  const entries = input.sessions.map((session): AgentEntry => {
    const tokens = tokenTotal(session.tokens)
    return {
      sessionID: session.id,
      title: session.title ?? session.id,
      directory: session.directory,
      state: agentState(input.status(session.id)),
      ...(session.model ? { model: `${session.model.providerID}/${session.model.id}` } : {}),
      ...(session.cost === undefined ? {} : { cost: session.cost }),
      ...(tokens === undefined ? {} : { tokens }),
    }
  })
  const rank: Record<AgentState, number> = { busy: 0, retry: 1, idle: 2 }
  const sorted = [...entries].sort((a, b) => {
    const state = rank[a.state] - rank[b.state]
    if (state !== 0) return state
    const at = byID.get(a.sessionID)?.time.updated ?? 0
    const bt = byID.get(b.sessionID)?.time.updated ?? 0
    return bt - at
  })
  return input.limit === undefined ? sorted : sorted.slice(0, input.limit)
}

export function activeCount(agents: readonly AgentEntry[]): number {
  return agents.filter((agent) => agent.state !== "idle").length
}