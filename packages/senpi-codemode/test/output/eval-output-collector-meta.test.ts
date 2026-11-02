import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES } from "../../src/output/streaming-output.ts";
import { EvalOutputCollector } from "../../src/tool/image.ts";

function collector(maxColumns: number): EvalOutputCollector {
	return new EvalOutputCollector({ headBytes: 0, maxColumns, model: undefined, onChunk: () => {} });
}

describe("eval output truncation metadata", () => {
	it("attributes a width-clamped line to the column cap, not a byte limit", async () => {
		// Given
		const output = collector(8);
		output.push(`${"x".repeat(20)}\n`);

		// When
		const result = await output.finish();

		// Then
		expect(result.meta).toMatchObject({ truncatedBy: "columns", maxColumns: 8, columnTruncatedLines: 1 });
		expect(result.meta?.maxBytes).toBeUndefined();
	});

	it("reports the real byte cap when the tail buffer dropped output", async () => {
		// Given
		const output = collector(0);
		output.push(`${"y".repeat(DEFAULT_MAX_BYTES + 10)}\n`);

		// When
		const result = await output.finish();

		// Then
		expect(result.meta).toMatchObject({ truncatedBy: "bytes", maxBytes: DEFAULT_MAX_BYTES });
	});
});
