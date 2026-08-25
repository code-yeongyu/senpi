import { describe, expect, it } from "vitest";
import type { Tool } from "@earendil-works/pi-ai";
import { compactionSummarizationTools } from "../../src/core/extensions/builtin/compaction/summarization-tools.ts";

describe("compactionSummarizationTools", () => {
	it("returns no tools even when the live agent list is non-empty", () => {
		const live = [
			{
				name: "bash",
				description: "run a command",
				parameters: { type: "object", properties: {} },
			},
		] as Tool[];
		expect(compactionSummarizationTools(live)).toEqual([]);
		expect(compactionSummarizationTools()).toEqual([]);
	});
});
