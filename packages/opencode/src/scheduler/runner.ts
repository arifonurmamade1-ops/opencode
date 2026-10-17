import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Cause, Context, Duration, Effect, Exit, Layer, Schedule } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Scheduler } from "./scheduler"
import { conditionInterval } from "./schedule"

/**
 * Executes due scheduler tasks by creating a session per run and prompting the
 * agent with the task's prompt.
 *
 * Kept separate from the store so the schedule tool can manage tasks without
 * depending on SessionPrompt (which depends on the tool registry).
 */

const POLL = Duration.seconds(15)

export type Report = {
  started: number
  checks: number
  condition: number
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly tick: (input?: { detach?: boolean; now?: number }) => Effect.Effect<Report>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SchedulerRunner") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const processes = yield* AppProcess.Service
    // Detached runs live as long as the runner layer itself.
    const scope = yield* Effect.scope

    const run = Effect.fn("SchedulerRunner.run")(function* (task: Scheduler.Info) {
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const session = yield* sessions.create({
            title: `scheduled: ${task.name ?? task.id}`,
            agent: task.agent,
            model: task.model ? { id: task.model.modelID, providerID: task.model.providerID } : undefined,
          })
          yield* prompts.prompt({
            sessionID: session.id,
            agent: task.agent,
            model: task.model,
            parts: [{ type: "text", text: task.prompt }],
          })
          return session
        }),
      )
      yield* scheduler.recordRun({
        id: task.id,
        sessionID: Exit.isSuccess(outcome) ? outcome.value.id : undefined,
        error: Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : undefined,
        time: Date.now(),
      })
    })

    const matches = (exitCode: number, expect: "success" | "failure") =>
      expect === "failure" ? exitCode !== 0 : exitCode === 0

    const evaluate = Effect.fn("SchedulerRunner.evaluate")(function* (task: Scheduler.Info) {
      const spec = task.schedule
      if (spec.type !== "condition") return false
      const context = yield* InstanceState.context
      const command =
        process.platform === "win32"
          ? ChildProcess.make("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", spec.check], {
              cwd: context.directory,
              extendEnv: true,
              stdin: "ignore",
            })
          : ChildProcess.make(spec.check, [], {
              shell: process.env.SHELL ?? "/bin/sh",
              cwd: context.directory,
              extendEnv: true,
              stdin: "ignore",
            })
      // A check that cannot run at all (missing binary, spawn error) counts as
      // "not matched" so a `failure` condition does not fire on broken checks.
      const result = yield* processes.run(command).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!result) return false
      return matches(result.exitCode, spec.expect ?? "success")
    })

    const tick = Effect.fn("SchedulerRunner.tick")(function* (input?: { detach?: boolean; now?: number }) {
      const report: Report = { started: 0, checks: 0, condition: 0 }
      if (!(yield* scheduler.schedulerEnabled())) return report
      const detach = input?.detach === true
      const launch = (task: Scheduler.Info) =>
        detach ? run(task).pipe(Effect.forkIn(scope), Effect.asVoid) : run(task)
      const now = input?.now ?? Date.now()
      const due = yield* scheduler.claimDue(now)
      const checks = yield* scheduler.claimChecks(now)
      report.started = due.length
      report.checks = checks.length
      yield* Effect.forEach(due, launch, { concurrency: "unbounded", discard: true })
      yield* Effect.forEach(
        checks,
        (task) =>
          Effect.gen(function* () {
            const matched = yield* evaluate(task)
            yield* scheduler.recordCheck({ id: task.id, matched, time: now })
            if (!matched || task.state.lastCheckMatched === true) return
            const claimed = yield* scheduler.claimRun({ id: task.id, now })
            if (!claimed) return
            report.condition += 1
            yield* launch(claimed)
          }),
        { concurrency: 1, discard: true },
      )
      return report
    })

    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        yield* tick({ detach: true }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("scheduler tick failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(POLL)),
          Effect.forkScoped,
        )
      }),
    )

    const init = () => InstanceState.get(state)

    return Service.of({ init, tick })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Scheduler.node, Session.node, SessionPrompt.node, AppProcess.node],
})

export * as SchedulerRunner from "./runner"
