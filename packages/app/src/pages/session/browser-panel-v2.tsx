import { Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useBrowser } from "@/context/browser"
import { usePlatform } from "@/context/platform"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSizing } from "@/pages/session/helpers"

export function BrowserPanelV2(props: { stacked?: boolean } = {}) {
  const layout = useLayout()
  const browser = useBrowser()
  const language = useLanguage()
  const platform = usePlatform()
  const { view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const opened = createMemo(() => view().browser.opened())
  const size = createSizing()
  const height = createMemo(() => layout.browser.height())
  const close = () => view().browser.close()

  let root: HTMLDivElement | undefined
  let inputRef: HTMLInputElement | undefined

  const [store, setStore] = createStore({
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
  })

  const max = () => store.view * 0.6
  const pane = () => Math.min(height(), max())
  const stacked = createMemo(() => isDesktop() && props.stacked)
  const panelHeight = createMemo(() =>
    isDesktop() ? (stacked() ? `${pane()}px` : "100%") : opened() ? `${pane()}px` : "0px",
  )
  const contentHeight = createMemo(() => (isDesktop() ? (stacked() ? `${pane()}px` : "100%") : `${pane()}px`))

  const url = createMemo(() => browser.url())
  const [input, setInput] = createSignal("")
  const [focused, setFocused] = createSignal(false)

  createEffect(() => {
    if (focused()) return
    setInput(url() ?? "")
  })

  onMount(() => {
    if (typeof window === "undefined") return
    const sync = () => setStore("view", window.visualViewport?.height ?? window.innerHeight)
    const port = window.visualViewport
    sync()
    makeEventListener(window, "resize", sync)
    if (port) makeEventListener(port, "resize", sync)
  })

  const submit = (event: Event) => {
    event.preventDefault()
    const value = input()
    if (!value) return
    browser.navigate(value)
    inputRef?.blur()
  }

  return (
    <aside
      ref={root}
      id="browser-panel"
      role="region"
      aria-label={language.t("browser.title")}
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative shrink-0 overflow-hidden bg-v2-background-bg-base"
      classList={{
        "w-full": !isDesktop() || stacked(),
        "min-w-0 h-full flex-1": isDesktop() && opened() && !stacked(),
        "w-0 h-full pointer-events-none": isDesktop() && !opened(),
        "rounded-[10px] shadow-[var(--v2-elevation-raised)]": isDesktop(),
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !isDesktop() && !size.active(),
      }}
      style={{ height: panelHeight() }}
    >
      <div classList={{ "md:hidden": !stacked(), hidden: stacked() }} onPointerDown={() => size.start()}>
        <ResizeHandle
          classList={{
            "-top-1": true,
          }}
          direction="vertical"
          size={pane()}
          min={100}
          max={max()}
          collapseThreshold={50}
          onResize={(next) => {
            size.touch()
            layout.browser.resize(next)
          }}
          onCollapse={close}
        />
      </div>
      <div
        class="absolute inset-0 flex flex-col overflow-hidden"
        classList={{
          "border-t border-border-weak-base": opened() && !isDesktop(),
          "border-t border-border-weaker-base": opened() && stacked(),
          "border-l border-border-weaker-base": opened() && isDesktop() && !stacked(),
          "pointer-events-none": !opened(),
        }}
        style={{ height: contentHeight() }}
      >
        <form class="flex items-center gap-1 h-10 px-1 border-b border-border-weaker-base bg-v2-background-bg-base" onSubmit={submit}>
          <TooltipKeybind title={language.t("browser.back")} keybind="">
            <IconButton
              icon="chevron-left"
              variant="ghost"
              iconSize="normal"
              disabled={!browser.canBack()}
              onClick={browser.back}
              aria-label={language.t("browser.back")}
            />
          </TooltipKeybind>
          <TooltipKeybind title={language.t("browser.forward")} keybind="">
            <IconButton
              icon="chevron-right"
              variant="ghost"
              iconSize="normal"
              disabled={!browser.canForward()}
              onClick={browser.forward}
              aria-label={language.t("browser.forward")}
            />
          </TooltipKeybind>
          <input
            ref={inputRef}
            class="flex-1 min-w-0 h-7 px-2 rounded-md bg-v2-background-bg-base text-14-regular text-text-base border border-border-weaker-base focus:outline-none focus:border-border-weak-base"
            value={input()}
            onInput={(event) => setInput(event.currentTarget.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={language.t("browser.url.placeholder")}
            aria-label={language.t("browser.url.placeholder")}
          />
          <TooltipKeybind title={language.t("browser.reload")} keybind="">
            <IconButton
              icon="refresh"
              variant="ghost"
              iconSize="normal"
              onClick={browser.reload}
              aria-label={language.t("browser.reload")}
            />
          </TooltipKeybind>
          <TooltipKeybind title={language.t("browser.openExternal")} keybind="">
            <IconButton
              icon="square-arrow-top-right"
              variant="ghost"
              iconSize="normal"
              disabled={!url()}
              onClick={() => {
                const current = url()
                if (current) platform.openExternal(current)
              }}
              aria-label={language.t("browser.openExternal")}
            />
          </TooltipKeybind>
          <TooltipKeybind title={language.t("browser.close")} keybind="">
            <IconButton
              icon="close-small"
              variant="ghost"
              iconSize="normal"
              onClick={close}
              aria-label={language.t("browser.close")}
            />
          </TooltipKeybind>
        </form>
        <div class="flex-1 min-h-0 relative overflow-hidden">
          <Show
            when={url()}
            fallback={
              <div class="flex flex-col h-full items-center justify-center text-text-weak gap-1 p-4 text-center">
                <div class="text-16-regular">{language.t("browser.empty")}</div>
                <div class="text-13-regular text-text-faint">{language.t("browser.empty.note")}</div>
              </div>
            }
          >
            {(currentUrl) => (
              <Show when={`${currentUrl()}::${browser.reloadKey()}`} keyed>
                <iframe
                  src={currentUrl()}
                  title={language.t("browser.title")}
                  class="absolute inset-0 w-full h-full border-0"
                />
              </Show>
            )}
          </Show>
        </div>
      </div>
    </aside>
  )
}