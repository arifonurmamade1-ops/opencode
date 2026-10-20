// Keep `--version` on a minimal import path. The full CLI graph pulls in every
// command module (providers, MCP, server, TUI), which makes a version probe one
// of the most expensive ways to start the process.
const args = process.argv.slice(2)
const separator = args.indexOf("--")
const flags = separator === -1 ? args : args.slice(0, separator)
const wantsVersion = flags.includes("--version") || flags.includes("-v")
const wantsHelp = flags.includes("--help") || flags.includes("-h")

if (wantsVersion && !wantsHelp) {
  const { InstallationVersion } = await import("@opencode-ai/core/installation/version")
  console.log(InstallationVersion)
} else {
  await import("./cli/main")
}
