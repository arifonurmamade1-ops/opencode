export type BrowserHistory = {
  stack: string[]
  index: number
}

export const initialBrowserHistory: BrowserHistory = { stack: [], index: -1 }

export function normalizeUrl(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return url.href
}

export function navigate(history: BrowserHistory, url: string): BrowserHistory {
  const normalized = normalizeUrl(url)
  if (!normalized) return history
  const currentUrl = current(history)
  if (currentUrl === normalized) return history
  const stack = history.stack.slice(0, history.index + 1)
  stack.push(normalized)
  return { stack, index: stack.length - 1 }
}

export function back(history: BrowserHistory): BrowserHistory {
  if (!canBack(history)) return history
  return { ...history, index: history.index - 1 }
}

export function forward(history: BrowserHistory): BrowserHistory {
  if (!canForward(history)) return history
  return { ...history, index: history.index + 1 }
}

export function canBack(history: BrowserHistory): boolean {
  return history.index > 0
}

export function canForward(history: BrowserHistory): boolean {
  return history.index < history.stack.length - 1
}

export function current(history: BrowserHistory): string | undefined {
  if (history.index < 0 || history.index >= history.stack.length) return undefined
  return history.stack[history.index]
}

export function migrate(value: unknown): BrowserHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return initialBrowserHistory
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.stack) || !v.stack.every((entry) => typeof entry === "string")) return initialBrowserHistory
  if (typeof v.index !== "number" || !Number.isInteger(v.index)) return initialBrowserHistory
  const clamped = Math.min(Math.max(v.index, -1), v.stack.length - 1)
  return { stack: v.stack, index: clamped }
}