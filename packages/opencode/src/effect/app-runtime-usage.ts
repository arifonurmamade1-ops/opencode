/**
 * Mutable usage latch for {@link app-runtime} (see ./app-runtime-usage.ts).
 *
 * Tests consult this during teardown to skip the (heavy) `app-runtime`
 * module import and dispose call when the suite never touched `AppRuntime`,
 * keeping suite-level `afterAll` hooks under bun's default timeout on slow
 * environments.
 */
export let used = false

export function markAppRuntimeUsed() {
  used = true
}

export function appRuntimeUsed() {
  return used
}

export * as AppRuntimeUsage from "./app-runtime-usage"
