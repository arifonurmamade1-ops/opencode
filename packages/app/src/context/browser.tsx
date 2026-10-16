import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createRoot, createSignal, on, onCleanup } from "solid-js"
import { useSDK, type DirectorySDK } from "./sdk"
import { useServerSDK } from "./server-sdk"
import { Persist, persisted } from "@/utils/persist"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { makeEventListener } from "@solid-primitives/event-listener"
import {
  type BrowserHistory,
  initialBrowserHistory,
  migrate,
  navigate,
  back,
  forward,
  current,
  canBack,
  canForward,
  normalizeUrl,
} from "@/pages/session/browser-model"

const WORKSPACE_KEY = "__workspace__"
const MAX_BROWSER_SESSIONS = 20

type BrowserSession = {
  history: () => BrowserHistory
  url: () => string | undefined
  canBack: () => boolean
  canForward: () => boolean
  navigate: (url: string) => void
  back: () => void
  forward: () => void
  reload: () => void
  reloadKey: () => number
}

type BrowserCacheEntry = {
  value: BrowserSession
  dispose: VoidFunction
}

const caches = new Set<Map<string, BrowserCacheEntry>>()

function getWorkspaceBrowserCacheKey(dir: string, scope: ServerScopeValue = ServerScope.local) {
  return ScopedKey.from(scope, dir, WORKSPACE_KEY)
}

function browserPersistTarget(scope: ServerScopeValue, dir: string) {
  return Persist.serverWorkspace(scope, dir, "browser")
}

function createWorkspaceBrowserSession(sdk: DirectorySDK, dir: string, scope: ServerScopeValue): BrowserSession {
  const [store, setStore] = persisted(
    { ...browserPersistTarget(scope, dir), migrate },
    createStore(initialBrowserHistory),
  )

  const [reloadKey, setReloadKey] = createSignal(0)

  const history = createMemo(() => migrate(store))
  const url = createMemo(() => current(history()))

  const apply = (next: BrowserHistory) => {
    batch(() => {
      setStore("stack", next.stack)
      setStore("index", next.index)
    })
  }

  const doNavigate = (url: string) => {
    const next = navigate(history(), url)
    if (next === history()) return
    apply(next)
  }
  const doBack = () => {
    const next = back(history())
    if (next === history()) return
    apply(next)
  }
  const doForward = () => {
    const next = forward(history())
    if (next === history()) return
    apply(next)
  }

  return {
    history,
    url,
    canBack: () => canBack(history()),
    canForward: () => canForward(history()),
    navigate: doNavigate,
    back: doBack,
    forward: doForward,
    reload: () => setReloadKey((key) => key + 1),
    reloadKey,
  }
}

export const { use: useBrowser, provider: BrowserProvider } = createSimpleContext({
  name: "Browser",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const cache = new Map<string, BrowserCacheEntry>()
    const scope = () => serverSDK().scope
    const directory = createMemo(() => base64Encode(sdk().directory))

    caches.add(cache)
    onCleanup(() => caches.delete(cache))

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }
    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_BROWSER_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const loadWorkspace = (dir: string, serverScope: ServerScopeValue) => {
      const key = getWorkspaceBrowserCacheKey(dir, serverScope)
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createWorkspaceBrowserSession(sdk(), dir, serverScope),
        dispose,
      }))
      cache.set(key, entry)
      prune()
      return entry.value
    }

    const workspace = createMemo(() => loadWorkspace(directory(), scope()))

    createEffect(
      on(
        () => ({ dir: directory(), scope: scope() }),
        (next, prev) => {
          if (!prev?.dir) return
          if (next.dir === prev.dir && next.scope === prev.scope) return
          loadWorkspace(prev.dir, prev.scope).reload()
        },
        { defer: true },
      ),
    )

    // Open chat links in the browser panel. Runs once at provider mount and
    // is cleaned up automatically when the provider scope disposes.
    makeEventListener(document, "click", (event: MouseEvent) => {
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a.external-link")
      if (!(anchor instanceof HTMLAnchorElement)) return
      const href = anchor.getAttribute("href")
      if (!href) return
      const url = normalizeUrl(href)
      if (!url) return
      event.preventDefault()
      workspace().navigate(url)
    })

    return {
      history: () => workspace().history(),
      url: () => workspace().url(),
      canBack: () => workspace().canBack(),
      canForward: () => workspace().canForward(),
      navigate: (url: string) => workspace().navigate(url),
      back: () => workspace().back(),
      forward: () => workspace().forward(),
      reload: () => workspace().reload(),
      reloadKey: () => workspace().reloadKey(),
    }
  },
})