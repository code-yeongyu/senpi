import { describe, expect, it } from "vitest";
import {
	applyGeneratedCompaction,
	type SpeculativeCompactionContext,
} from "../../../src/core/extensions/builtin/compaction/speculative.ts";

function cursorContext(isIdle: boolean): SpeculativeCompactionContext {
	return {
		model: { provider: "cursor" } as SpeculativeCompactionContext["model"],
		isIdle: () => isIdle,
		sessionManager: {} as SpeculativeCompactionContext["sessionManager"],
		getContextUsage: () => undefined,
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
	};
}

describe("984 cursor mid-turn compact skip", () => {
	it("rejects apply while a Cursor run is not idle", async () => {
		const result = await applyGeneratedCompaction(cursorContext(false), undefined, () => 0, undefined);
		expect(result).toEqual({ applied: false, reason: "rejected" });
	});

	it("still reports unavailable when Cursor is idle and there is no snapshot", async () => {
		const result = await applyGeneratedCompaction(cursorContext(true), undefined, () => 0, undefined);
		expect(result).toEqual({ applied: false, reason: "unavailable" });
	});
});
