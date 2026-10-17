import type { FileSelection } from "@/context/file"

export const INLINE_EDIT_COMMANDS = [
  { action: "explain", title: "command.inline.explain", description: "command.inline.explain.description" },
  { action: "fix", title: "command.inline.fix", description: "command.inline.fix.description" },
  { action: "refactor", title: "command.inline.refactor", description: "command.inline.refactor.description" },
  { action: "tests", title: "command.inline.tests", description: "command.inline.tests.description" },
  { action: "docs", title: "command.inline.docs", description: "command.inline.docs.description" },
  { action: "generate", title: "command.inline.generate", description: "command.inline.generate.description" },
] as const

export type InlineEditAction = (typeof INLINE_EDIT_COMMANDS)[number]["action"]

export type InlineEditTarget = {
  path?: string
  selection?: Pick<FileSelection, "startLine" | "endLine"> | null
}

/**
 * Builds the prompt text for an inline editing command. The text is the slash
 * command the server resolves plus a compact reference to the active file and
 * selection, so the agent knows the target even before reading the attached
 * context.
 */
export function inlineEditText(action: InlineEditAction, target?: InlineEditTarget) {
  const path = target?.path
  if (!path) return `/${action}`
  const selection = target.selection
  const range = selection ? `:${selection.startLine}-${selection.endLine}` : ""
  return `/${action} ${path}${range}`
}
