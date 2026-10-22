import { TextAttributes } from "@opentui/core"
import type { RGBA } from "@opentui/core"
import { For, Show, createMemo, createSignal } from "solid-js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { build, render, summary } from "../doctor"

export function DialogDoctor() {
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const dialog = useDialog()
  const clipboard = useClipboard()
  const toast = useToast()
  const [copied, setCopied] = createSignal(false)

  dialog.setSize("large")

  const checks = createMemo(() =>
    build({
      connection: sync.status,
      config: sync.data.config,
      providers: sync.data.provider,
      connected: sync.data.provider_next.connected,
      mcp: sync.data.mcp,
      lsp: sync.data.lsp,
      vcs: sync.data.vcs,
      model: local.model.current(),
      version: InstallationVersion,
    }),
  )

  const copy = () => {
    void clipboard
      .write?.(render(checks()))
      .then(() => {
        setCopied(true)
        toast.show({ message: "Doctor report copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  useBindings(() => ({
    bindings: [{ key: "return", desc: "Copy doctor report", group: "Dialog", cmd: copy }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Doctor
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box>
        <For each={checks()}>
          {(check) => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={color(check.status, theme)}>
                  [{check.status}]
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{check.title}</b> <span style={{ fg: theme.textMuted }}>{check.summary}</span>
                </text>
              </box>
              <Show when={check.status !== "ok" && check.nextAction}>
                <text fg={theme.textMuted} paddingLeft={2} wrapMode="word">
                  next: {check.nextAction}
                </text>
              </Show>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>{summary(checks())}</text>
        <text onMouseUp={copy}>
          <span style={{ fg: copied() ? theme.success : theme.text }}>
            <b>{copied() ? "copied" : "copy"}</b>{" "}
          </span>
          <span style={{ fg: theme.textMuted }}>enter</span>
        </text>
      </box>
    </box>
  )
}

function color(
  status: "ok" | "warn" | "fail" | "skip",
  theme: { success: RGBA; warning: RGBA; error: RGBA; textMuted: RGBA },
) {
  return {
    ok: theme.success,
    warn: theme.warning,
    fail: theme.error,
    skip: theme.textMuted,
  }[status]
}
