/**
 * Extracts the current compatibility surfaces — FASE 32.
 *
 * The extraction is deliberately split from the pure diff in `audit.ts` so the
 * CI script and the tests share the exact same view of the tree. Runtime
 * schemas are introspected instead of duplicated; source-level surfaces (CLI
 * commands, tools, plugin hooks) are read from the modules that define them.
 */
import { existsSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { PLUGIN_API_VERSION } from "@opencode-ai/plugin"
import { TuiKeybind } from "@opencode-ai/tui/config/keybind"
import { OpenCodeHttpApi } from "../server/routes/instance/httpapi/api"
import { BASELINE_VERSION, type Snapshot } from "./audit"

export async function extractSnapshot(root: string): Promise<Snapshot> {
  const packageDir = join(root, "packages", "opencode")
  return {
    version: BASELINE_VERSION,
    cli: await extractCli(packageDir),
    config: extractConfig(),
    agents: await extractAgents(packageDir),
    tools: await extractTools(packageDir),
    plugin: await extractPlugin(join(root, "packages", "plugin")),
    tui: await extractTui(join(root, "packages", "tui")),
    api: extractApi(),
    scripts: await extractScripts(root),
  }
}

/**
 * Reads the top-level commands registered in `src/cli/main.ts`, plus the nested
 * commands, aliases, and flags declared by the command modules. `src/index.ts`
 * is only the startup shim, so the command tree lives one level deeper. The
 * identity includes the defining file so two `list` subcommands do not collide;
 * moving a command to another module is therefore a contract change.
 */
export async function extractCli(packageDir: string): Promise<Snapshot["cli"]> {
  const srcDir = join(packageDir, "src")
  const entryDir = join(srcDir, "cli")
  const cmdDir = join(entryDir, "cmd")
  const index = await Bun.file(join(entryDir, "main.ts")).text()

  const imports = new Map<string, string>()
  for (const match of index.matchAll(/import\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*from\s*"([^"]+)"/g)) {
    imports.set(match[1], match[2])
  }

  const commands = new Set<string>()
  const aliases = new Set<string>()
  const topLevelCommands = new Set<string>()
  const topLevelAliases = new Set<string>()

  for (const match of index.matchAll(/\.command\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const binding = match[1]
    const specifier = imports.get(binding)
    if (!specifier) throw new Error(`CLI command ${binding} has no local import in ${entryDir}/main.ts`)
    const file = resolveCliModule(entryDir, specifier)
    const text = await Bun.file(file).text()
    const start = text.indexOf(`export const ${binding} =`)
    if (start < 0) throw new Error(`cannot find the definition of ${binding} in ${file}`)
    // Stop at the header properties so a following command definition in the
    // same file cannot contribute aliases to this one.
    const body = text.slice(start, start + 4000).split(/\n\s*(?:builder|handler|describe)\s*:/)[0]
    const command =
      /^[ \t]*command:\s*"([^"]+)"/m.exec(body)?.[1] ?? /^[ \t]*command:\s*\[[^\]]*?"([^"]+)"/m.exec(body)?.[1]
    if (!command) throw new Error(`cannot read the command string for ${binding} in ${file}`)
    commands.add(commandName(command))
    const id = relativeId(file, cmdDir)
    topLevelCommands.add(`${id}::${command}`)
    for (const alias of stringLiterals(/^[ \t]*aliases:\s*\[([^\]]*)\]/m.exec(body)?.[1])) {
      aliases.add(alias)
      topLevelAliases.add(`${id}::${alias}`)
    }
  }

  const completion = /\.completion\(\s*"([^"]+)"/.exec(index)?.[1]
  if (completion) commands.add(commandName(completion))

  const globalOptions = new Set<string>()
  for (const match of index.matchAll(/\.option\(\s*"([^"]+)"/g)) globalOptions.add(flagName(match[1]))
  for (const match of index.matchAll(/\.(?:help|version)\(\s*"([^"]+)"/g)) globalOptions.add(flagName(match[1]))

  const subcommands = new Set<string>()
  const subcommandAliases = new Set<string>()
  const options = new Set<string>()
  for (const file of await listTypeScriptFiles(cmdDir)) {
    const id = file.replaceAll("\\", "/")
    // `cmd/run/` contains the run TUI and demo fixtures, not CLI command
    // definitions; its strings must not become part of the contract.
    if (id.startsWith("run/")) continue
    const text = await Bun.file(join(cmdDir, file)).text()
    for (const match of text.matchAll(/^[ \t]*command:\s*"([^"]+)"/gm)) {
      const key = `${id}::${match[1]}`
      if (!topLevelCommands.has(key)) subcommands.add(key)
    }
    for (const match of text.matchAll(/^[ \t]*aliases:\s*\[([^\]]*)\]/gm)) {
      for (const alias of stringLiterals(match[1])) {
        const key = `${id}::${alias}`
        if (!topLevelAliases.has(key)) subcommandAliases.add(key)
      }
    }
    for (const match of text.matchAll(/\.option\(\s*"([^"]+)"/g)) {
      options.add(`${id}::${flagName(match[1])}`)
    }
  }

  return {
    commands: [...commands].sort(),
    aliases: [...aliases].sort(),
    globalOptions: [...globalOptions].sort(),
    subcommands: [...subcommands].sort(),
    subcommandAliases: [...subcommandAliases].sort(),
    options: [...options].sort(),
  }
}

/** Built-in agent names from `src/agent/agent.ts`. */
export async function extractAgents(packageDir: string): Promise<string[]> {
  const text = await Bun.file(join(packageDir, "src", "agent", "agent.ts")).text()
  const names = new Set([...text.matchAll(/^\s+name:\s*"([^"]+)"/gm)].map((match) => match[1]))
  if (names.size === 0) throw new Error("no agent names found in src/agent/agent.ts")
  return [...names].sort()
}

/**
 * Built-in tool ids. Tool ids are the first argument of `Tool.define`; most are
 * string literals, while shell and code-mode reference exported constants.
 */
export async function extractTools(packageDir: string): Promise<string[]> {
  const toolDir = join(packageDir, "src", "tool")
  const sources = new Map<string, string>()
  for (const file of await listTypeScriptFiles(toolDir)) {
    sources.set(file, await Bun.file(join(toolDir, file)).text())
  }

  const exported = new Map<string, Set<string>>()
  for (const text of sources.values()) {
    for (const match of text.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"/g)) {
      addConstant(exported, match[1], match[2])
    }
  }

  const ids = new Set<string>()
  for (const [file, text] of sources) {
    for (const id of extractToolIds(text, stringConstants(text), exported, file)) ids.add(id)
  }
  if (ids.size === 0) throw new Error("no tool ids found in src/tool")
  return [...ids].sort()
}

/** Top-level config keys plus the documented nested agent and MCP shapes. */
export function extractConfig(): Snapshot["config"] {
  return {
    keys: schemaFields(ConfigV1.Info, "ConfigV1.Info"),
    agent: schemaFields(ConfigAgentV1.Info, "ConfigAgentV1.Info"),
    mcp: {
      local: schemaFields(ConfigMCPV1.Local, "ConfigMCPV1.Local"),
      remote: schemaFields(ConfigMCPV1.Remote, "ConfigMCPV1.Remote"),
    },
  }
}

/** Plugin API version and the hook names exposed by the `Hooks` interface. */
export async function extractPlugin(pluginDir: string): Promise<Snapshot["plugin"]> {
  const text = await Bun.file(join(pluginDir, "src", "index.ts")).text()
  const start = text.indexOf("export interface Hooks {")
  if (start < 0) throw new Error("cannot find the Hooks interface in packages/plugin/src/index.ts")
  const end = text.indexOf("\n}", start)
  if (end < 0) throw new Error("cannot find the end of the Hooks interface")
  const hooks = new Set(
    [...text.slice(start, end).matchAll(/^ {2}(?:"([^"]+)"|([A-Za-z_$][\w$]*))\??\s*:/gm)].map(
      (match) => match[1] ?? match[2],
    ),
  )
  if (hooks.size === 0) throw new Error("no plugin hooks found in the Hooks interface")
  return { apiVersion: PLUGIN_API_VERSION, hooks: [...hooks].sort() }
}

/**
 * TUI config keys and every keybind action with its default binding.
 *
 * The config keys are read from the `Info` schema source because that module
 * also owns the Solid context and JSX runtime; importing it would tie the
 * audit to a JSX-capable tsconfig.
 */
export async function extractTui(tuiDir: string): Promise<Snapshot["tui"]> {
  const definitions = TuiKeybind.Definitions as unknown as Record<string, { default?: unknown }>
  const keybinds: Record<string, unknown> = {}
  for (const key of Object.keys(definitions).sort()) {
    const definition = definitions[key]
    if (!definition || !Object.hasOwn(definition, "default")) {
      throw new Error(`TUI keybind ${key} has no default binding`)
    }
    keybinds[key] = sortValue(definition.default)
  }
  return {
    config: await extractTuiConfig(tuiDir),
    keybinds,
  }
}

async function extractTuiConfig(tuiDir: string): Promise<string[]> {
  const file = join(tuiDir, "src", "config", "index.tsx")
  const text = await Bun.file(file).text()
  const marker = "export const Info = Schema.Struct({"
  const start = text.indexOf(marker)
  if (start < 0) throw new Error(`cannot find the TUI Info schema in ${file}`)
  const end = text.indexOf("\n})", start)
  if (end < 0) throw new Error(`cannot find the end of the TUI Info schema in ${file}`)
  const keys = new Set<string>()
  for (const line of text.slice(start + marker.length, end).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue
    const match = /^([A-Za-z_$][\w$]*):/.exec(trimmed)
    if (!match) throw new Error(`unsupported line in the TUI Info schema: ${trimmed}`)
    keys.add(match[1])
  }
  if (keys.size === 0) throw new Error(`no keys found in the TUI Info schema in ${file}`)
  return [...keys].sort()
}

/** HTTP API endpoints as `METHOD /path`, read from the combined HttpApi. */
export function extractApi(): string[] {
  const api = OpenCodeHttpApi as unknown as {
    groups: Record<string, { endpoints: Record<string, { method: string; path: string }> }>
  }
  const endpoints = new Set<string>()
  for (const group of Object.values(api.groups)) {
    for (const endpoint of Object.values(group.endpoints)) {
      endpoints.add(`${endpoint.method.toUpperCase()} ${endpoint.path}`)
    }
  }
  if (endpoints.size === 0) throw new Error("no HTTP API endpoints found")
  return [...endpoints].sort()
}

/** Root workflow scripts (`dev`, `typecheck`, `license:audit`, ...). */
export async function extractScripts(root: string): Promise<string[]> {
  const manifest: unknown = await Bun.file(join(root, "package.json")).json()
  if (typeof manifest !== "object" || manifest === null || !("scripts" in manifest)) {
    throw new Error("root package.json has no scripts")
  }
  const scripts = (manifest as { scripts?: unknown }).scripts
  if (typeof scripts !== "object" || scripts === null) throw new Error("root package.json scripts must be an object")
  return Object.keys(scripts).sort()
}

function extractToolIds(
  text: string,
  local: Map<string, Set<string>>,
  exported: Map<string, Set<string>>,
  file: string,
): string[] {
  const ids: string[] = []
  let index = text.indexOf("Tool.define")
  while (index >= 0) {
    let cursor = skipWhitespace(text, index + "Tool.define".length)
    if (text[cursor] === "<") {
      cursor = skipGenerics(text, cursor, file)
      cursor = skipWhitespace(text, cursor)
    }
    if (text[cursor] !== "(") {
      index = text.indexOf("Tool.define", index + "Tool.define".length)
      continue
    }
    cursor = skipWhitespace(text, cursor + 1)
    if (text[cursor] === '"') {
      const end = text.indexOf('"', cursor + 1)
      if (end < 0) throw new Error(`unterminated tool id in ${file}`)
      ids.push(text.slice(cursor + 1, end))
      index = text.indexOf("Tool.define", end + 1)
      continue
    }
    const expression = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(text.slice(cursor))
    if (!expression) throw new Error(`unsupported tool id expression in ${file}`)
    const name = expression[0].split(".").pop()
    const values = expression[0].includes(".")
      ? exported.get(name ?? "")
      : (local.get(expression[0]) ?? exported.get(expression[0]))
    if (!values || values.size !== 1) {
      throw new Error(
        `cannot resolve tool id "${expression[0]}" in ${file}; use a string literal or one exported constant`,
      )
    }
    ids.push([...values][0])
    index = text.indexOf("Tool.define", cursor + expression[0].length)
  }
  return ids
}

function skipGenerics(text: string, start: number, file: string): number {
  let depth = 0
  for (let cursor = start; cursor < text.length; cursor++) {
    const char = text[cursor]
    if (char === "<") depth++
    if (char === ">" && text[cursor - 1] !== "=") {
      depth--
      if (depth === 0) return cursor + 1
    }
  }
  throw new Error(`unterminated generic list for Tool.define in ${file}`)
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++
  return cursor
}

function stringConstants(text: string): Map<string, Set<string>> {
  const constants = new Map<string, Set<string>>()
  for (const match of text.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"/gm)) {
    addConstant(constants, match[1], match[2])
  }
  return constants
}

function addConstant(target: Map<string, Set<string>>, name: string, value: string): void {
  const values = target.get(name) ?? new Set<string>()
  values.add(value)
  target.set(name, values)
}

function resolveCliModule(srcDir: string, specifier: string): string {
  const base = resolve(srcDir, specifier)
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`cannot resolve CLI module ${specifier}`)
}

function commandName(usage: string): string {
  const head = usage.trim().split(/\s+/)[0]
  return head === "$0" ? "(default)" : head
}

function flagName(name: string): string {
  return name.startsWith("-") ? name : `--${name}`
}

function stringLiterals(text: string | undefined): string[] {
  if (!text) return []
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function relativeId(file: string, directory: string): string {
  return relative(directory, file).replaceAll("\\", "/")
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const files = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: directory, onlyFiles: true }))
  return files.sort()
}

type SchemaShape = {
  fields?: Record<string, unknown>
  ast?: { propertySignatures?: ReadonlyArray<{ name: string }> }
}

function schemaFields(schema: unknown, label: string): string[] {
  const shape = schema as SchemaShape
  if (shape?.fields) return Object.keys(shape.fields).sort()
  const properties = shape?.ast?.propertySignatures
  if (properties) return properties.map((property) => property.name).sort()
  throw new Error(`cannot read the fields of ${label}`)
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])]),
    )
  }
  return value
}

export * as CompatibilitySurface from "./surface"
