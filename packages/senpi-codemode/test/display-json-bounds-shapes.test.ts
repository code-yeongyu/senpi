import { describe, expect, test } from "vitest";
import { sanitizeDisplayJson } from "../src/tool/display-json-bounds.ts";
import { MAX_DISPLAY_JSON_BYTES } from "../src/tool/display-json-size.ts";

function serializedLength(value: unknown): number {
	return JSON.stringify(value).length;
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a record");
	return value as Record<string, unknown>;
}

const rows = Array.from({ length: 300 }, (_, index) => ({
	id: index,
	name: `user-${index}`,
	email: `user-${index}@example.com`,
	active: index % 2 === 0,
}));

describe("display values keep every top-level key within the budget (#3261 review)", () => {
	test("a paginated response keeps its scalars after a large rows array", () => {
		const stored = record(sanitizeDisplayJson({ rows, total: 300, page: 1, next: "cursor-2" }));

		expect(Object.keys(stored)).toEqual(["rows", "total", "page", "next"]);
		expect(stored.total).toBe(300);
		expect(stored.page).toBe(1);
		expect(stored.next).toBe("cursor-2");
		expect(serializedLength(stored)).toBeLessThanOrEqual(MAX_DISPLAY_JSON_BYTES);
	});

	test("kept records keep all their own fields", () => {
		const stored = record(sanitizeDisplayJson({ rows }));
		const kept = stored.rows;
		if (!Array.isArray(kept)) throw new Error("expected an array");

		expect(kept[0]).toEqual(rows[0]);
		expect(String(kept.at(-1))).toMatch(/more items/);
	});

	test("a key after an escaped string is kept", () => {
		const stored = record(sanitizeDisplayJson({ a: "\u0001".repeat(3_000), list: rows, z: 1 }));

		expect(Object.keys(stored)).toEqual(["a", "list", "z"]);
		expect(stored.z).toBe(1);
		expect(serializedLength(stored)).toBeLessThanOrEqual(MAX_DISPLAY_JSON_BYTES);
	});

	test.each([
		["a 100,000-character key", { ["K".repeat(100_000)]: 1, b: 2 }],
		["a key of 3,000 control characters", { ["\u0001".repeat(3_000)]: 1, b: 2 }],
	])("%s is trimmed, the sibling is kept, and the budget holds", (_label, value) => {
		const stored = record(sanitizeDisplayJson(value));

		expect(Object.keys(stored)).toHaveLength(2);
		expect(stored.b).toBe(2);
		expect(serializedLength(stored)).toBeLessThanOrEqual(MAX_DISPLAY_JSON_BYTES);
	});

	test("too many keys to show still stays within the budget with a visible count", () => {
		const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`key-${index}`, "v".repeat(500)]));
		const stored = record(sanitizeDisplayJson(wide));

		expect(serializedLength(stored)).toBeLessThanOrEqual(MAX_DISPLAY_JSON_BYTES);
		expect(Object.values(stored).some((value) => typeof value === "string" && value.includes("more keys"))).toBe(
			true,
		);
	});

	test("emoji-heavy records keep their scalars and the budget holds", () => {
		const messages = Array.from({ length: 300 }, (_, index) => ({ id: index, text: "\u{1F389}".repeat(150) }));
		const stored = record(sanitizeDisplayJson({ messages, total: 300, page: 1 }));

		expect(Object.keys(stored)).toEqual(["messages", "total", "page"]);
		expect(stored.total).toBe(300);
		expect(stored.page).toBe(1);
		expect(Array.isArray(stored.messages)).toBe(true);
		expect(serializedLength(stored)).toBeLessThanOrEqual(MAX_DISPLAY_JSON_BYTES);
	});

	test("emoji keys stay keys and a trimmed emoji string never splits a surrogate pair", () => {
		const value = Object.fromEntries(
			Array.from({ length: 150 }, (_, index) => [`${"\u{1F600}".repeat(40)}-${index}`, index]),
		);
		const stored = record(sanitizeDisplayJson(value));

		expect(Object.keys(stored).length).toBeGreaterThan(1);
		expect(serializedLength(stored)).toBeLessThanOrEqual(MAX_DISPLAY_JSON_BYTES);
		expect(JSON.stringify(stored)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
	});
});
