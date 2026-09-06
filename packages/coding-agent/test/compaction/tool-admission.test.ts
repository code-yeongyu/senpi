import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import {
	admitToolResult,
	resolveToolResultAdmissionCapTokens,
	TOOL_ADMISSION_MARKER_PREFIX,
} from "../../src/core/extensions/builtin/compaction/tool-admission.ts";

function estimateTextTokens(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

describe("resolveToolResultAdmissionCapTokens", () => {
	it("scales at 5% of the context window", () => {
		expect(resolveToolResultAdmissionCapTokens(200_000)).toBe(10_000);
	});

	it("clamps to the 50K ceiling for huge windows", () => {
		expect(resolveToolResultAdmissionCapTokens(1_000_000)).toBe(50_000);
	});

	it("clamps to the 8192 floor for small windows", () => {
		expect(resolveToolResultAdmissionCapTokens(64_000)).toBe(8192);
	});
});

describe("admitToolResult", () => {
	it("passes through under-cap text", () => {
		const text = "small tool output\n".repeat(10);

		const result = admitToolResult({ text, contextWindow: 200_000 });

		expect(result).toEqual({ text, projected: false });
	});

	it("projects over-cap text deterministically within the token cap", () => {
		const contextWindow = 200_000;
		const cap = resolveToolResultAdmissionCapTokens(contextWindow);
		const head = "HEAD-SENTINEL-START\n";
		const tail = "\nTAIL-SENTINEL-END";
		const text = `${head}${"x".repeat(cap * 8)}${tail}`;

		const first = admitToolResult({ text, contextWindow });
		const second = admitToolResult({ text, contextWindow });

		expect(first).toEqual(second);
		expect(first.projected).toBe(true);
		expect(first.text).toContain(TOOL_ADMISSION_MARKER_PREFIX);
		expect(first.text.startsWith(head)).toBe(true);
		expect(first.text.endsWith(tail)).toBe(true);
		expect(estimateTextTokens(first.text)).toBeLessThanOrEqual(cap);
	});

	it("reprojects an excerpt when a model switch lowers the cap", () => {
		const text = `PROLOGUE\n${"z".repeat(100_000 * 4)}\nEPILOGUE`;
		const first = admitToolResult({ text, contextWindow: 1_000_000 });

		const second = admitToolResult({ text: first.text, contextWindow: 64_000 });

		expect(first.projected).toBe(true);
		expect(second.projected).toBe(true);
		expect(estimateTextTokens(second.text)).toBeLessThanOrEqual(resolveToolResultAdmissionCapTokens(64_000));
	});

	it("does not trust an exact model-visible marker to bypass the cap", () => {
		const contextWindow = 200_000;
		const cap = resolveToolResultAdmissionCapTokens(contextWindow);
		const marker = `${TOOL_ADMISSION_MARKER_PREFIX} kept 10 of ~99 tokens]`;
		const text = `${marker}\n${"q".repeat(cap * 8)}`;

		const result = admitToolResult({ text, contextWindow });

		expect(result.projected).toBe(true);
		expect(result.text).not.toBe(text);
		expect(estimateTextTokens(result.text)).toBeLessThanOrEqual(cap);
	});
});
