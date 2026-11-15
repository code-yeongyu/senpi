/**
 * omo#12965 re-read, F3b: the turn-origin registry instance in the realm was built by another copy (planted before this
 * file's modules load; each test file has its own realm). An answer that is not exactly `false` reads as delegated.
 */
import { describe, expect, it } from "vitest";

const planted: { delegated: unknown; closeAtRunStart: unknown } = { delegated: false, closeAtRunStart: false };
Object.defineProperty(globalThis, Symbol.for("@code-yeongyu/senpi/turn-origin/v1"), {
	value: Object.freeze({
		run: (_origin: unknown, handle: () => unknown) => handle(),
		delegated: () => planted.delegated,
		closeAtRunStart: () => planted.closeAtRunStart,
	}),
	writable: false,
	configurable: false,
	enumerable: false,
});

describe("F3b a turn-origin instance another copy built, answering something other than a boolean", () => {
	it("reads the exact answer false as not delegated, and engine work as engine", async () => {
		const origin = await import("../../src/core/turn-origin.ts");
		planted.delegated = false;
		planted.closeAtRunStart = false;
		const sessionManager = {};
		expect(origin.recordIsDelegated()).toBe(false);
		origin.noteRunStart(sessionManager);
		expect(origin.decidingTurnIsDelegated(sessionManager)).toBe(false);
	});

	for (const unreadable of ["yes", undefined, null, 1]) {
		it(`reads ${String(unreadable)} as delegated`, async () => {
			const origin = await import("../../src/core/turn-origin.ts");
			planted.delegated = unreadable;
			planted.closeAtRunStart = unreadable;
			const sessionManager = {};
			expect(origin.recordIsDelegated()).toBe(true);
			expect(origin.inputTurnMark({ source: "interactive" })).toBe("delegated");
			origin.noteRunStart(sessionManager);
			expect(origin.decidingTurnIsDelegated(sessionManager)).toBe(true);
		});
	}
});
