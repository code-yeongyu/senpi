import { describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../src/harness/session/uuid.ts";

const TIMESTAMP = 0x01_9d_00_00_00_00;
const TASK_COUNT = 64;

describe("uuidv7 concurrent callers", () => {
	it("generates unique, monotonic IDs when async tasks interleave in one millisecond", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(TIMESTAMP);
		try {
			const ids = await Promise.all(
				Array.from({ length: TASK_COUNT }, async () => {
					await Promise.resolve();
					return uuidv7();
				}),
			);

			expect(new Set(ids)).toHaveLength(TASK_COUNT);
			expect(ids).toEqual([...ids].sort());
			expect(ids.every((id) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16) === TIMESTAMP)).toBe(true);
		} finally {
			dateNow.mockRestore();
		}
	});
});
