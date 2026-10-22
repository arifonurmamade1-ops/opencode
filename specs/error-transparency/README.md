# Error transparency

FASE 35 makes failures actionable. Every surfaced failure is rendered with the
same six fields:

```text
WHAT: Unable to reach the remote service
WHY: ConnectionRefused: Unable to connect to the provider
WHERE: opencode run
ATTEMPTED: Send the request to the session and wait for the response.
RESULT: The request failed.
NEXT ACTION: Check the remote URL, network, proxy, or VPN configuration, then retry.
```

Generic output such as "Something went wrong" is not used. If a component
cannot provide a message, the reason explicitly says so and the next action
points at diagnostics.

## Fields

| Field         | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `WHAT`        | Short classification of the failure.                             |
| `WHY`         | The underlying message, including a cause when one is available. |
| `WHERE`       | Command, session, tool, or subsystem that failed.                |
| `ATTEMPTED`   | Action or actions that were tried.                               |
| `RESULT`      | What happened after the attempt.                                 |
| `NEXT ACTION` | Concrete recovery step.                                          |

## Implementation

`packages/opencode/src/error/report.ts` exposes `ErrorReport.from`,
`ErrorReport.render`, and `ErrorReport.format`. The formatter classifies common
failures (configuration, provider model/auth, network, timeout, permission,
missing resource, invalid tool arguments, cancellation) and supplies a matching
next action. Callers provide the operation context.

Integration points:

- top-level CLI failures and command-line parsing in `src/cli/main.ts`;
- API and session failures in `opencode run`, including the interactive session
  error reducer;
- attach and TUI startup validation;
- TUI error toasts and crash screens, which now report why a message is missing
  instead of showing "An unknown error occurred";
- tool failures in the run stream and in `SessionProcessor.failToolCall`, so the
  TUI, API clients, and the model receive the same structured reason;
- the delegated task failure path in `Session.prompt`.

`FormatError` remains the domain-specific detail formatter. Error transparency
wraps its output instead of replacing it, preserving existing configuration,
provider, and account diagnostics.

## Tests

```sh
cd packages/opencode
bun test test/error test/session/processor-effect.test.ts
```

The stress paths cover unknown errors, multiline causes, network/timeout/
permission classification, provider-model and configuration guidance, explicit
context overrides, and the absence of generic fallback messages.
