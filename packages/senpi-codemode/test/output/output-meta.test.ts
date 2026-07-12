import { describe, expect, it } from "vitest";
import { formatTruncationWarning, stripOutputNotice, type TruncationMeta } from "../../src/output/output-meta.ts";
import { artifactNotice } from "../../src/output/streaming-output.ts";

const tailMeta = {
	direction: "tail",
	truncatedBy: "bytes",
	totalLines: 10,
	totalBytes: 100,
	outputLines: 3,
	outputBytes: 5,
	maxBytes: 5,
	shownRange: { start: 8, end: 10 },
	artifactId: "/tmp/full.log",
} satisfies TruncationMeta;

describe("output metadata", () => {
	it("formats a plain tail truncation warning with its artifact path", () => {
		// Given
		const meta = tailMeta;

		// When
		const warning = formatTruncationWarning(meta);

		// Then
		expect(warning).toBe("[Showing lines 8-10 of 10 (5B limit). Full output: /tmp/full.log]");
	});

	it("formats a middle-elision warning", () => {
		// Given
		const meta = {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: 10,
			totalBytes: 2_048,
			outputLines: 5,
			outputBytes: 1_024,
			headRange: { start: 1, end: 2 },
			tailRange: { start: 9, end: 10 },
			elidedLines: 6,
			elidedBytes: 1_024,
		} satisfies TruncationMeta;

		// When
		const warning = formatTruncationWarning(meta);

		// Then
		expect(warning).toBe("[Showing lines 1-2 and 9-10 of 10; 6 middle lines (1.0KB) elided]");
	});

	it("strips the formatted warning from a completed output", () => {
		// Given
		const warning = formatTruncationWarning(tailMeta);
		const output = `visible output\n\n${warning}\n`;

		// When
		const stripped = stripOutputNotice(output, tailMeta);

		// Then
		expect(stripped).toBe("visible output");
	});

	it("leaves unrelated output unchanged", () => {
		// Given
		const output = "visible output\n[caller supplied note]";

		// When
		const stripped = stripOutputNotice(output, tailMeta);

		// Then
		expect(stripped).toBe(output);
	});

	it("formats the plain-path artifact notice", () => {
		// Given
		const path = "/tmp/session-artifacts/eval.log";

		// When
		const notice = artifactNotice(path);

		// Then
		expect(notice).toBe("[Full output: /tmp/session-artifacts/eval.log]");
	});
});
