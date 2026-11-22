import { describe, expect, it } from "vitest";
import type { CompactionSettings } from "../../src/core/compaction/index.ts";
import { shouldRunIdleCompaction } from "../../src/core/extensions/builtin/compaction/idle.ts";
import type { ContextUsage, ExtensionMode } from "../../src/core/extensions/types.ts";

function baseInput(
	overrides: Partial<Parameters<typeof shouldRunIdleCompaction>[0]> = {},
): Parameters<typeof shouldRunIdleCompaction>[0] {
	const settings: CompactionSettings = {
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
	};
	const usage: ContextUsage = { tokens: 80_000, contextWindow: 100_000, percent: 80 };
	return {
		willRetry: false,
		aborted: false,
		settings,
		usage,
		contextWindow: 100_000,
		breakerTripped: false,
		mode: "tui" as ExtensionMode,
		...overrides,
	};
}

describe("shouldRunIdleCompaction", () => {
	it("runs when over the threshold and all guards pass (default enabled)", () => {
		expect(shouldRunIdleCompaction(baseInput())).toBe(true);
	});

	it("runs in rpc mode too", () => {
		expect(shouldRunIdleCompaction(baseInput({ mode: "rpc" }))).toBe(true);
	});

	it("does not run when the run will auto-continue", () => {
		expect(shouldRunIdleCompaction(baseInput({ willRetry: true }))).toBe(false);
	});

	it("does not run when the run was aborted", () => {
		expect(shouldRunIdleCompaction(baseInput({ aborted: true }))).toBe(false);
	});

	it("does not run in one-shot print mode", () => {
		expect(shouldRunIdleCompaction(baseInput({ mode: "print" }))).toBe(false);
	});

	it("does not run in one-shot json mode", () => {
		expect(shouldRunIdleCompaction(baseInput({ mode: "json" }))).toBe(false);
	});

	it("does not run when idleCompactionEnabled is false", () => {
		expect(
			shouldRunIdleCompaction(
				baseInput({
					settings: {
						enabled: true,
						reserveTokens: 16384,
						keepRecentTokens: 20000,
						idleCompactionEnabled: false,
					},
				}),
			),
		).toBe(false);
	});

	it("does not run when the circuit breaker is tripped", () => {
		expect(shouldRunIdleCompaction(baseInput({ breakerTripped: true }))).toBe(false);
	});

	it("does not run when usage is undefined", () => {
		expect(shouldRunIdleCompaction(baseInput({ usage: undefined }))).toBe(false);
	});

	it("does not run when usage.tokens is null", () => {
		expect(shouldRunIdleCompaction(baseInput({ usage: { tokens: null, contextWindow: 100_000, percent: 0 } }))).toBe(
			false,
		);
	});

	it("does not run when below the compaction threshold", () => {
		expect(
			shouldRunIdleCompaction(baseInput({ usage: { tokens: 20_000, contextWindow: 100_000, percent: 20 } })),
		).toBe(false);
	});
});
