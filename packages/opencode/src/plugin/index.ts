import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { ModalPlugin } from "./modal/modal"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { CerebrasPlugin } from "./cerebras"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, pluginSource, readPluginApi, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { PluginApi } from "./api"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { HooksPlugin } from "@/hook/plugin"

type State = {
  hooks: Hooks[]
  inventory: PluginApi.PluginRecord[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly inventory: () => Effect.Effect<PluginApi.PluginRecord[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
      }),
    CopilotAuthPlugin,
    ModalPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    SnowflakeCortexAuthPlugin,
    XaiAuthPlugin,
    CerebrasPlugin,
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

type Applied =
  | { ok: true; id: string; api: number; hooks: Hooks[] }
  | { ok: false; skipped: boolean; error: string }

// Load one plugin module into validated hooks. A plugin that requires a newer
// API version is skipped, and hooks that do not match the stable API are
// rejected before registration, so a broken plugin cannot take down core paths.
async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput): Promise<Applied> {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    const id = await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    const api = readPluginApi(plugin, load.spec) ?? PluginApi.API_VERSION
    const problem = PluginApi.apiVersionProblem(api)
    if (problem) return { ok: false, skipped: true, error: `Plugin ${load.spec} skipped: ${problem}` }
    return validateHooks([await (plugin as PluginModule).server(input, load.options)], load.spec, id, api)
  }

  const hooks: Hooks[] = []
  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
  return validateHooks(hooks, load.spec, load.spec, PluginApi.API_VERSION)
}

function validateHooks(hooks: Hooks[], spec: string, id: string, api: number): Applied {
  const problems = hooks.flatMap((entry) => PluginApi.validate(entry))
  if (problems.length) {
    return { ok: false, skipped: false, error: `Plugin ${spec} returned an invalid plugin API: ${problems.join("; ")}` }
  }
  return { ok: true, id, api, hooks }
}

function inventoryRecord(input: {
  id: string
  spec: string
  source: PluginApi.Source
  api?: number
  status: PluginApi.Status
  description?: PluginApi.Description
  error?: string
}) {
  return {
    id: input.id,
    spec: input.spec,
    source: input.source,
    api: input.api ?? PluginApi.API_VERSION,
    status: input.status,
    capabilities: input.description?.capabilities ?? [],
    hooks: input.description?.hooks ?? [],
    tools: input.description?.tools ?? [],
    ...(input.error === undefined ? {} : { error: input.error }),
  } satisfies PluginApi.PluginRecord
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const inventory: PluginApi.PluginRecord[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        // Lifecycle hooks are user-configured (see "hooks" in opencode.json), so
        // they stay active even when default plugins are disabled.
        const internal: PluginInstance[] = [
          HooksPlugin,
          ...(flags.disableDefaultPlugins ? [] : internalPlugins(flags)),
        ]
        for (const [index, plugin] of internal.entries()) {
          const id = plugin.name || `internal.${index}`
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.map((hooks) => ({ ok: true as const, hooks })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          )
          if (init.ok) {
            hooks.push(init.hooks)
            inventory.push(
              inventoryRecord({
                id,
                spec: "internal",
                source: "internal",
                status: "loaded",
                description: PluginApi.describe(init.hooks),
              }),
            )
            continue
          }
          inventory.push(
            inventoryRecord({
              id,
              spec: "internal",
              source: "internal",
              status: "failed",
              error: `Internal plugin ${id} failed to load: ${init.error}`,
            }),
          )
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const failures = new Map<string, PluginApi.PluginRecord>()
        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {
                const spec = candidate.plan.spec
                failures.set(
                  spec,
                  inventoryRecord({
                    id: spec,
                    spec,
                    source: pluginSource(spec),
                    status: "skipped",
                    error: message,
                  }),
                )
              },
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  const detail = `Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`
                  publishPluginError(detail)
                  failures.set(
                    spec,
                    inventoryRecord({ id: spec, spec, source: pluginSource(spec), status: "failed", error: detail }),
                  )
                  return
                }

                if (stage === "compatibility") {
                  const detail = `Plugin ${spec} skipped: ${message}`
                  publishPluginError(detail)
                  failures.set(
                    spec,
                    inventoryRecord({ id: spec, spec, source: pluginSource(spec), status: "skipped", error: detail }),
                  )
                  return
                }

                const detail = `Failed to load plugin ${spec}: ${message}`
                publishPluginError(detail)
                failures.set(
                  spec,
                  inventoryRecord({ id: spec, spec, source: pluginSource(spec), status: "failed", error: detail }),
                )
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          const outcome = yield* Effect.tryPromise({
            try: () => applyPlugin(load, input),
            catch: (err) => `Failed to load plugin ${load.spec}: ${errorMessage(err)}`,
          }).pipe(
            Effect.catch((message) => Effect.succeed({ ok: false as const, skipped: false as const, error: message })),
          )
          failures.delete(load.spec)
          if (outcome.ok) {
            hooks.push(...outcome.hooks)
            inventory.push(
              inventoryRecord({
                id: outcome.id,
                spec: load.spec,
                source: load.source,
                api: outcome.api,
                status: "loaded",
                description: PluginApi.describe(outcome.hooks),
              }),
            )
            continue
          }
          yield* Effect.logError("failed to load plugin", { path: load.spec, error: outcome.error })
          publishPluginError(outcome.error)
          inventory.push(
            inventoryRecord({
              id: load.spec,
              spec: load.spec,
              source: load.source,
              status: outcome.skipped ? "skipped" : "failed",
              error: outcome.error,
            }),
          )
        }
        inventory.push(...failures.values())

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              const fn = hook["event"]
              if (!fn) continue
              // Event hooks are fire-and-forget, but a plugin rejection or
              // synchronous throw must never surface as an unhandled
              // rejection or block event delivery for other plugins.
              bridge.fork(
                Effect.tryPromise({
                  try: () => fn({ event: { id: event.id, type: event.type, properties: event.data } as any }),
                  catch: errorMessage,
                }).pipe(
                  Effect.tapError((error) => Effect.logError("plugin event hook failed", { error })),
                  Effect.ignore,
                ),
              )
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return { hooks, inventory }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const inventory = Effect.fn("Plugin.inventory")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.inventory]
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, inventory, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, RuntimeFlags.node],
})

export * as Plugin from "."
