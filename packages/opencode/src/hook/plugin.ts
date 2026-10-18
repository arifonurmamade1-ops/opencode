export * as HookPlugin from "./plugin"

import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { Hook } from "./hook"

// Lifecycle hooks as an internal plugin.
//
// The hook system is config-driven (see ./hook): every stage is bridged onto
// the plugin trigger hooks and session events that core already publishes, so
// user hooks work for global and project configs without changing core paths.
// Hook commands are best-effort: they run with a timeout, failures are logged,
// and a broken hook can never fail the stage that triggered it.

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])

export const HooksPlugin: Plugin = async (input) => {
  let definitions: Hook.Definitions = {}

  async function dispatch(stage: Hook.Stage, fields: Record<string, unknown>) {
    const entries = definitions[stage]
    if (!entries?.length) return
    try {
      const directory = input.directory
      const env = Hook.environment({
        stage,
        directory,
        sessionID: typeof fields.sessionID === "string" ? fields.sessionID : undefined,
        tool: typeof fields.tool === "string" ? fields.tool : undefined,
      })
      const payload = Hook.payload({ hook: stage, directory, ...fields })
      for (const entry of entries) {
        const result = await execute({ entry, cwd: directory, env, payload })
        if (!result.ok) console.warn(`[hook] ${stage} "${entry.command}" failed: ${result.reason}`)
      }
    } catch (error) {
      // Hooks must never break the stage that triggered them.
      console.warn(`[hook] ${stage} dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    async config(cfg) {
      const normalized = Hook.normalize((cfg as { hooks?: unknown }).hooks)
      definitions = normalized.hooks
      for (const problem of normalized.problems) console.warn(`[hook] ${problem}`)
    },
    async "tool.execute.before"(toolInput, output) {
      const fields = {
        tool: toolInput.tool,
        sessionID: toolInput.sessionID,
        callID: toolInput.callID,
        args: output.args,
      }
      await dispatch("before_tool", fields)
      if (toolInput.tool === "task") await dispatch("before_task", fields)
      else if (EDIT_TOOLS.has(toolInput.tool)) await dispatch("before_edit", fields)
    },
    async "tool.execute.after"(toolInput, output) {
      const fields = {
        tool: toolInput.tool,
        sessionID: toolInput.sessionID,
        callID: toolInput.callID,
        args: toolInput.args,
        title: output.title,
        output: output.output,
        metadata: output.metadata,
      }
      await dispatch("after_tool", fields)
      if (toolInput.tool === "task") await dispatch("after_task", fields)
      else if (EDIT_TOOLS.has(toolInput.tool)) await dispatch("after_edit", fields)
    },
    async "model.before"(modelInput) {
      await dispatch("before_model", {
        sessionID: modelInput.sessionID,
        messageID: modelInput.messageID,
        agent: modelInput.agent,
        model: modelInput.model,
      })
    },
    async "model.after"(modelInput) {
      await dispatch("after_model", {
        sessionID: modelInput.sessionID,
        messageID: modelInput.messageID,
        agent: modelInput.agent,
        model: modelInput.model,
        finish: modelInput.finish,
        cost: modelInput.cost,
        tokens: modelInput.tokens,
      })
    },
    async "commit.before"(commitInput, output) {
      await dispatch("before_commit", { ...commitInput, message: output.message })
    },
    async "commit.after"(commitInput) {
      await dispatch("after_commit", { ...commitInput })
    },
    async event(eventInput) {
      const properties = (eventInput.event.properties ?? {}) as Record<string, unknown>
      if (eventInput.event.type === "session.idle") {
        await dispatch("on_stop", { sessionID: properties.sessionID })
        return
      }
      if (eventInput.event.type === "session.error") {
        await dispatch("on_error", { sessionID: properties.sessionID, error: properties.error })
      }
    },
  } satisfies Hooks
}

export type Execution = { ok: true } | { ok: false; reason: string }

/** Run one hook command: payload on stdin, stage info in the environment. */
export async function execute(input: {
  entry: Hook.Entry
  cwd: string
  env: Record<string, string>
  payload: string
}): Promise<Execution> {
  if (typeof Bun === "undefined") return { ok: false, reason: "Bun runtime is not available" }
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const proc = Bun.spawn(shellCommand(input.entry.command), {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdin: Buffer.from(input.payload),
      stdout: "ignore",
      stderr: "pipe",
      // cmd.exe needs verbatim arguments: Bun's default quoting escapes inner
      // quotes with backslashes, which cmd.exe cannot parse.
      ...(process.platform === "win32"
        ? { windowsVerbatimArguments: true }
        : // A process group on POSIX lets the timeout kill the whole tree.
          { detached: true }),
    })
    const stderr = new Response(proc.stderr).text()
    timer = setTimeout(() => {
      expired = true
      terminate(proc)
    }, input.entry.timeout)
    const code = await proc.exited
    if (expired) return { ok: false, reason: `timed out after ${input.entry.timeout}ms` }
    if (code !== 0) {
      const detail = (await stderr).trim()
      return { ok: false, reason: detail ? `exited with code ${code}: ${detail.slice(0, 2000)}` : `exited with code ${code}` }
    }
    return { ok: true }
  } catch (error) {
    if (expired) return { ok: false, reason: `timed out after ${input.entry.timeout}ms` }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function terminate(proc: ReturnType<typeof Bun.spawn>) {
  try {
    if (process.platform !== "win32") {
      process.kill(-proc.pid, "SIGKILL")
      return
    }
    // cmd.exe runs the command as a child: killing only cmd.exe would leave the
    // grandchild alive holding the stdio pipes open.
    Bun.spawn(["taskkill", "/t", "/f", "/pid", String(proc.pid)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
  } catch {
    // The process already exited; nothing to terminate.
  }
}

function shellCommand(command: string): string[] {
  if (process.platform !== "win32") return [process.env.SHELL ?? "/bin/sh", "-c", command]
  const comspec = process.env.COMSPEC ?? "cmd.exe"
  // Spawned with windowsVerbatimArguments, so the whole command is wrapped in
  // one pair of quotes that cmd.exe strips while parsing /c.
  const exe = comspec.includes(" ") ? "cmd.exe" : comspec
  return [exe, "/d", "/s", "/c", `"${command}"`]
}
