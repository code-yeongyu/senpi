import { describe, expect, it } from "vitest";
import { DEFAULT_SUMMARIZATION_MAX_DURATION_MS } from "../../src/core/compaction/stream-watchdog.ts";

describe("DEFAULT_SUMMARIZATION_MAX_DURATION_MS", () => {
	it("gives large-session summarization 15 minutes", () => {
		expect(DEFAULT_SUMMARIZATION_MAX_DURATION_MS).toBe(900_000);
	});
});
