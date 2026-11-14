/**
 * senpi#5929: the close path's grace timer is armed before a dispose that can throw synchronously.
 * When `binding.dispose()` throws, the error reaches `finalizeClose`'s catch, but the timer stays armed
 * for up to `closeGraceMs`. Here the dispose throws synchronously: the close must still settle, and no
 * grace timer may stay pending afterwards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcSessionBinding } from "../../../src/modes/rpc/session-binding.ts";
import type { RouterContext } from "../../../src/modes/rpc/session-router-context.ts";
import { finalizeClose } from "../../../src/modes/rpc/session-router-close.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("close path grace bound (senpi#5929)", () => {
	it("clears the grace timer when dispose throws synchronously, so no timer stays armed", async () => {
		// Given: fake timers, a binding whose dispose throws synchronously, and a minimal close host.
		vi.useFakeTimers();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const host = {
			finalizations: new Map(),
			bindings: new Map(),
			registry: {
				closeGraceMs: 2_000,
				closeMarked: async () => {},
				peek: () => undefined,
			},
		} as unknown as RouterContext;
		const binding = {
			dispose: () => {
				throw new Error("sync dispose boom");
			},
		} as unknown as RpcSessionBinding;

		// When: the finalizer side of the close runs.
		await finalizeClose(host, "s1", binding);

		// Then: the error was logged, and no grace timer stays armed.
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("senpi rpc binding dispose for session s1 failed"));
		expect(vi.getTimerCount()).toBe(0);
	});
});
