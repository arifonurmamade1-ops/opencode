import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// With a marker path configured the server fails its first launch and leaves
// the marker behind, so tests can observe connection retries.
const marker = process.env.MCP_POLICY_RETRY_MARKER
if (marker && !(await Bun.file(marker).exists())) {
  await Bun.write(marker, "1")
  process.exit(1)
}

const server = new Server({ name: "mcp-policy-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "environment",
        description: JSON.stringify({
          cwd: process.cwd(),
          leaked: process.env.MCP_POLICY_SECRET ?? null,
          configured: process.env.MCP_POLICY_CONFIGURED ?? null,
        }),
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "count",
        description: "Counts the calls received by this server",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
)

let calls = 0
server.setRequestHandler(CallToolRequestSchema, () =>
  Promise.resolve({ content: [{ type: "text", text: String(++calls) }] }),
)

await server.connect(new StdioServerTransport())
