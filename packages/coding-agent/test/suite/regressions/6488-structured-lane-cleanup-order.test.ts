import { expect, it, vi } from "vitest";
import { createStructuredHarness } from "../structured-lane-sdk-harness.ts";

// senpi#6488: callers close their provider scope right after calling cleanup(), so the structured harness must have
// disposed its session by the time cleanup() returns, not on a later microtask.
it("disposes the structured harness session before cleanup() returns", async () => {
	const harness = await createStructuredHarness();
	const dispose = vi.spyOn(harness.session, "dispose");
	const cleanup = harness.cleanup();
	expect(dispose).toHaveBeenCalledTimes(1);
	await cleanup;
});
