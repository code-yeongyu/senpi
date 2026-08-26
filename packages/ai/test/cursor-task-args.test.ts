import { describe, expect, it } from "vitest";
import { isUsableCursorTaskArgs, keepUsableCursorTaskArgs } from "../src/api/cursor-task-args.ts";

describe("keepUsableCursorTaskArgs", () => {
	it("rejects empty objects", () => {
		expect(isUsableCursorTaskArgs({})).toBe(false);
	});

	it("keeps previous usable task args when the complete frame is empty", () => {
		const prev: Record<string, unknown> = {
			category: "deep",
			prompt: "Gap analysis",
			task_summary: "Gap analysis",
		};
		expect(keepUsableCursorTaskArgs(prev, {})).toEqual(prev);
	});
});
