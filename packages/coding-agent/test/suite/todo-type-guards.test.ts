import { describe, expect, it } from "vitest";
import {
	getLatestPhasesFromBranchEntries,
	isTodoItem,
	isTodoItemArray,
	isTodoPhase,
	isTodoPhaseArray,
	TODO_STATE_ENTRY_TYPE,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

// Ported from pi-todotools 0.2.1 (sound todo type guards).
describe("todo type guards", () => {
	it("accepts only canonical statuses", () => {
		for (const status of ["pending", "in_progress", "completed", "abandoned"]) {
			expect(isTodoItem({ content: "task", status })).toBe(true);
		}
		expect(isTodoItem({ content: "task", status: "blocked" })).toBe(false);
		expect(isTodoItem({ status: "pending" })).toBe(false);
	});

	it("rejects the legacy cancelled status instead of narrowing an unmigrated value", () => {
		const legacy: unknown = { content: "task", status: "cancelled" };

		expect(isTodoItem(legacy)).toBe(false);
		expect(isTodoItemArray([legacy])).toBe(false);
		expect(isTodoPhase({ name: "Phase", tasks: [legacy] })).toBe(false);
		expect(isTodoPhaseArray([{ name: "Phase", tasks: [legacy] }])).toBe(false);
	});

	it("still migrates cancelled to abandoned on the persisted-state parse path", () => {
		const entry = {
			type: "custom",
			customType: TODO_STATE_ENTRY_TYPE,
			data: { schema: "v2", phases: [{ name: "Phase", tasks: [{ content: "task", status: "cancelled" }] }] },
		} as unknown as SessionEntry;

		expect(getLatestPhasesFromBranchEntries([entry])).toEqual([
			{ name: "Phase", tasks: [{ content: "task", status: "abandoned" }] },
		]);
	});
});
