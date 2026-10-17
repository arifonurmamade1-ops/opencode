import { describe, expect, test } from "bun:test"

// Importing AppLayer builds the full application node graph. A dependency cycle
// between bootstrap, the scheduler runner, session prompt and the tool registry
// would throw here instead of at server startup.
describe("scheduler wiring", () => {
  test(
    "the application layer builds with the scheduler runner",
    async () => {
      const { AppLayer } = await import("@/effect/app-runtime")
      expect(AppLayer).toBeDefined()
    },
    60_000,
  )
})
