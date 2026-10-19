export * as ConfigMCPV1 from "./mcp"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"
import { ConfigPermissionV1 } from "./permission"

export const Retry = Schema.Struct({
  attempts: Schema.optional(PositiveInt).annotate({
    description: "Total attempts, including the first, for connecting to and calling this server. Defaults to 1 (no retry).",
  }),
  delay: Schema.optional(NonNegativeInt).annotate({
    description: "Delay in milliseconds between attempts. Defaults to 250.",
  }),
}).annotate({ identifier: "McpRetryConfig" })
export type Retry = Schema.Schema.Type<typeof Retry>

export const RateLimit = Schema.Struct({
  requests: PositiveInt.annotate({ description: "Maximum number of tool calls allowed per window." }),
  window: PositiveInt.annotate({ description: "Window length in milliseconds." }),
}).annotate({ identifier: "McpRateLimitConfig" })
export type RateLimit = Schema.Schema.Type<typeof RateLimit>

export const Policy = Schema.Struct({
  permission: Schema.optional(ConfigPermissionV1.Info).annotate({
    description:
      "Default permission rules for this server's tools, keyed by tool name (or * for every tool of the server). Values are allow, ask, deny, or a map from tool name to action.",
  }),
  retry: Schema.optional(Retry).annotate({
    description: "Retry policy for connecting to and calling this server.",
  }),
  rateLimit: Schema.optional(RateLimit).annotate({
    description: "Maximum tool calls per time window. Calls over the limit fail immediately with a rate limit error.",
  }),
  trusted: Schema.optional(Schema.Boolean).annotate({
    description:
      "Trusted servers skip the permission prompt for their tools. Explicit deny rules still apply. Defaults to false.",
  }),
}).annotate({ identifier: "McpPolicyConfig" })

export const Local = Schema.Struct({
  type: Schema.Literal("local").annotate({ description: "Type of MCP server connection" }),
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "Command and arguments to run the MCP server",
  }),
  cwd: Schema.optional(Schema.String).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Environment variables to set when running the MCP server",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  sandbox: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the server with a minimal environment (only PATH and a few system variables are inherited; use environment for anything else) and confine it to the workspace directory. Defaults to false.",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 30000 (30 seconds) if not specified.",
  }),
  ...Policy.fields,
}).annotate({ identifier: "McpLocalConfig" })
export type Local = Schema.Schema.Type<typeof Local>

export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted.",
  }),
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth client secret (if required by the authorization server)",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "OAuth scopes to request during authorization" }),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    description:
      "Port for the local OAuth callback server (default: 19876). Shorthand for redirectUri when only the port needs changing. Ignored if redirectUri is set.",
  }),
  redirectUri: Schema.optional(Schema.String).annotate({
    description: "OAuth redirect URI (default: http://127.0.0.1:19876/mcp/oauth/callback).",
  }),
}).annotate({ identifier: "McpOAuthConfig" })
export type OAuth = Schema.Schema.Type<typeof OAuth>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Headers to send with the request",
  }),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description: "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 30000 (30 seconds) if not specified.",
  }),
  ...Policy.fields,
}).annotate({ identifier: "McpRemoteConfig" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>
