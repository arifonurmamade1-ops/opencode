import type { Session } from "@opencode-ai/sdk/v2/client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { createMemo, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createSessionContextFormatter } from "@/components/session/session-context-format"
import { useSettingsDialog } from "@/components/settings-dialog"
import { loadHomeSessionIndex } from "@/context/global-sync/home-session-index"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import {
  activeCount,
  activeAgents,
  attentionCount,
  buildPanels,
  type AgentEntry,
  type Panel,
} from "@/pages/dashboard/dashboard-model"
import { showToast } from "@/utils/toast"

const STATE_KEYS = {
  busy: "dashboard.agents.state.busy",
  retry: "dashboard.agents.state.retry",
  idle: "dashboard.agents.state.idle",
} as const

export function DialogDashboardV2(props: { server: ServerConnection.Any }) {
  const global = useGlobal()
  const language = useLanguage()
  const models = useModels()
  const tabs = useTabs()
  const dialog = useDialog()
  const openSettings = useSettingsDialog()
  const ctx = global.ensureServerCtx(props.server)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const [sessions] = createResource(
    () => ServerConnection.key(props.server),
    async (): Promise<Session[]> => {
      const index = await loadHomeSessionIndex((input, options) =>
        ctx.sdk.client.v2.session.list(input, options),
      )
      return index.sessions
    },
  )

  const status = (sessionID: string) => ctx.sync.session.data.session_status[sessionID]
  const pending = (sessionID: string) =>
    (ctx.sync.session.data.permission[sessionID]?.length ?? 0) +
    (ctx.sync.session.data.question[sessionID]?.length ?? 0)
  const agents = createMemo(() => activeAgents({ sessions: sessions() ?? [], status, pending }))
  const [stopping, setStopping] = createStore<Record<string, boolean>>({})
  const counts = createMemo(() => ({
    projects: ctx.projects.list().length,
    agents: (sessions() ?? []).length,
    models: models.list().length,
    providers: ctx.sync.data.provider.all.size,
  }))
  const panels = createMemo(() => buildPanels(counts()))

  const openSession = (entry: AgentEntry) => {
    ctx.projects.open(entry.directory)
    const tab = tabs.addSessionTab({ server: ServerConnection.key(props.server), sessionId: entry.sessionID })
    tabs.select(tab)
    dialog.close()
  }

  const stop = (entry: AgentEntry) => {
    if (stopping[entry.sessionID]) return
    setStopping(entry.sessionID, true)
    void ctx.sdk.client.v2.session
      .interrupt({ sessionID: entry.sessionID })
      .catch(() =>
        showToast({
          title: language.t("dashboard.agents.stop.failed"),
          description: entry.title,
        }),
      )
      .finally(() => setStopping(entry.sessionID, false))
  }

  return (
    <Dialog size="x-large" fit>
      <DialogHeader>
        <DialogTitle>{language.t("dashboard.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="max-h-[min(560px,calc(100vh-160px))] w-full flex-col gap-5 overflow-y-auto px-4 pt-4 pb-4">
        <section class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2 text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base">
            <Icon name="status-active" size="small" />
            {language.t("dashboard.agents.title")}
            <span class="text-v2-text-text-muted">{activeCount(agents())}</span>
            <Show when={attentionCount(agents()) > 0}>
              <span class="rounded-full bg-v2-state-bg-warning px-2 py-0.5 text-[11px] font-[530] leading-none tracking-[0.05px] text-v2-state-fg-warning">
                {language.plural("dashboard.agents.pending", attentionCount(agents()))}
              </span>
            </Show>
          </div>
          <Show
            when={sessions()}
            fallback={
              <div class="flex min-h-16 items-center justify-center text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted">
                {language.t("common.loading")}
              </div>
            }
          >
            <Show
              when={agents().length > 0}
              fallback={
                <div class="flex min-h-16 items-center justify-center text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted">
                  {language.t("dashboard.agents.empty")}
                </div>
              }
            >
              <ul class="flex flex-col">
                <For each={agents()}>
                  {(entry) => (
                    <li class="flex items-center gap-1">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-3 rounded-[6px] px-3 py-2 text-left hover:bg-v2-overlay-simple-overlay-hover"
                        onClick={() => openSession(entry)}
                      >
                        <span
                          class="size-2 shrink-0 rounded-full"
                          classList={{
                            "bg-v2-icon-icon-accent": entry.state === "busy",
                            "bg-v2-state-fg-warning": entry.state === "retry",
                            "bg-v2-icon-icon-muted": entry.state === "idle",
                          }}
                        />
                        <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base">
                          {entry.title}
                        </span>
                        <span class="shrink-0 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted">
                          {language.t(STATE_KEYS[entry.state])}
                        </span>
                        <Show when={entry.model}>
                          <span class="shrink-0 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted">
                            {entry.model}
                          </span>
                        </Show>
                        <Show when={entry.tokens !== undefined}>
                          <span class="shrink-0 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted">
                            {formatter().number(entry.tokens)}
                          </span>
                        </Show>
                      </button>
                      <Show when={entry.pending > 0}>
                        <span
                          class="shrink-0 rounded-full bg-v2-state-bg-warning px-1.5 py-0.5 text-[11px] font-[530] leading-none tracking-[0.05px] text-v2-state-fg-warning"
                          title={language.plural("dashboard.agents.pending", entry.pending)}
                          aria-label={language.plural("dashboard.agents.pending", entry.pending)}
                        >
                          {entry.pending}
                        </span>
                      </Show>
                      <Show when={entry.canInterrupt}>
                        <IconButtonV2
                          type="button"
                          variant="ghost-muted"
                          size="large"
                          class="shrink-0"
                          icon={<Icon name="stop" />}
                          disabled={stopping[entry.sessionID]}
                          onClick={() => stop(entry)}
                          aria-label={language.t("dashboard.agents.stop")}
                        />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </section>

        <section class="flex flex-col gap-2">
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <For each={panels().filter((panel) => panel.kind === "data")}>
              {(panel) => (
                <article class="flex flex-col gap-1 rounded-[6px] bg-v2-background-bg-layer-02 px-3 py-2">
                  <span class="text-[11px] font-[440] leading-none tracking-[0.05px] text-v2-text-text-muted">
                    {language.t(panel.labelKey)}
                  </span>
                  <span class="text-[15px] font-[530] leading-5 tracking-[-0.13px] text-v2-text-text-base">
                    {panel.count ?? 0}
                  </span>
                </article>
              )}
            </For>
          </div>
          <div class="flex flex-wrap gap-2">
            <For each={panels().filter((panel) => panel.kind !== "data")}>
              {(panel) => <PanelRow panel={panel} onOpenSettings={openSettings} />}
            </For>
          </div>
        </section>
      </DialogBody>
    </Dialog>
  )
}

function PanelRow(props: { panel: Panel; onOpenSettings: () => void }) {
  const language = useLanguage()
  const unavailable = () => props.panel.kind === "unavailable"

  return (
    <Show
      when={!unavailable()}
      fallback={
        <span class="flex items-center gap-2 rounded-[6px] border border-v2-border-border-base px-3 py-1.5 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-faint">
          {language.t(props.panel.labelKey)}
          <span class="text-v2-text-text-faint">{language.t(props.panel.reasonKey ?? "dashboard.panel.unavailable")}</span>
        </span>
      }
    >
      <ButtonV2 size="small" variant="outline" onClick={props.onOpenSettings}>
        {language.t(props.panel.labelKey)}
      </ButtonV2>
    </Show>
  )
}