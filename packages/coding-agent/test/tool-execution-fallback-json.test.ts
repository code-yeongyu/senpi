import { Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";

import { createToolResultFallback } from "../src/modes/interactive/components/tool-execution-fallback.ts";
import type { ToolExecutionResult } from "../src/modes/interactive/components/tool-execution-types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function textResult(text: string): ToolExecutionResult {
	return { content: [{ type: "text", text }], details: {}, isError: false };
}

function renderFallback(text: string, width = 200): string {
	const component = createToolResultFallback(textResult(text), false);
	if (!component) throw new Error("expected a fallback component");
	return component.render(width).join("\n");
}

function renderPlain(text: string, width = 200): string {
	return stripAnsi(renderFallback(text, width))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
}

/** Byte-exact rendering of the pre-existing fallback code path. */
function renderLegacyRaw(text: string, width = 200): string {
	return new Text(theme.fg("toolOutput", text), 0, 0).render(width).join("\n");
}

describe("createToolResultFallback JSON view", () => {
	beforeAll(() => initTheme("dark"));

	test("renders a nested JSON object as a bounded key-value view", () => {
		const payload = { goal: { status: "blocked", tokensUsed: 1838, nested: { a: 1 } } };
		const singleLine = JSON.stringify(payload);
		const pretty = JSON.stringify(payload, null, 2);

		const plain = renderPlain(singleLine);

		expect(plain).not.toContain(singleLine);
		expect(plain).not.toContain(pretty);
		expect(plain.split("\n")).toEqual(["goal:", "  status: blocked", "  tokensUsed: 1838", "  nested:", "    a: 1"]);
	});

	test("keeps plain prose byte-identical to the raw tool output styling", () => {
		const text = "hello world\nline2";
		expect(renderFallback(text)).toBe(renderLegacyRaw(text));
		expect(renderPlain(text)).toBe(text);
	});

	test("keeps malformed JSON byte-identical to the raw tool output styling", () => {
		const text = "{oops";
		expect(renderFallback(text)).toBe(renderLegacyRaw(text));
		expect(renderPlain(text)).toBe(text);
	});

	test("bounds row count and long string values", () => {
		const wide: Record<string, string> = {};
		for (let index = 0; index < 60; index += 1) {
			wide[`key${index}`] = `value${index}`;
		}
		const plain = renderPlain(JSON.stringify(wide));
		const lines = plain.split("\n");

		expect(lines.length).toBeLessThanOrEqual(25);
		const truncationLine = lines[lines.length - 1];
		expect(truncationLine).toMatch(/^… \d+ more$/);
		expect(truncationLine).toBe(`… ${60 - (lines.length - 1)} more`);

		const long = "x".repeat(250);
		const longPlain = renderPlain(JSON.stringify({ long }), 400);
		expect(longPlain).toBe(`long: ${"x".repeat(100)}…`);
	});

	test("renders a top-level array of primitives as a bounded list", () => {
		const values = Array.from({ length: 40 }, (_, index) => `item${index}`);
		const raw = JSON.stringify(values);
		const plain = renderPlain(raw);
		const lines = plain.split("\n");

		expect(plain).not.toContain(raw);
		expect(plain).toContain("item0");
		expect(lines.length).toBeLessThanOrEqual(25);
		expect(lines[lines.length - 1]).toMatch(/^… \d+ more$/);
	});
});
