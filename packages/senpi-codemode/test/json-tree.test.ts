import { describe, expect, it } from "vitest";
import { renderJsonTreeLines } from "../src/tool/json-tree.ts";

describe("renderJsonTreeLines", () => {
	it("renders nested objects and arrays with tree indentation", () => {
		// Given
		const value = { user: { name: "Ada" }, items: [1, 2] };

		// When
		const result = renderJsonTreeLines(value, undefined, 6, 20, 40);

		// Then
		expect(result.truncated).toBe(false);
		expect(result.lines[0]).toContain("user");
		expect(result.lines.some((line) => line.includes("name"))).toBe(true);
		expect(result.lines.some((line) => line.includes("[0]") && line.includes("├─"))).toBe(true);
	});

	it("shows an ellipsis when the depth cap is reached", () => {
		// Given
		const value = { a: { b: { c: { d: 1 } } } };

		// When
		const result = renderJsonTreeLines(value, undefined, 2, 20, 40);

		// Then
		expect(result.lines.some((line) => line.includes("…"))).toBe(true);
	});

	it("marks output truncated when the line cap is reached", () => {
		// Given
		const value = { first: 1, second: 2, third: 3 };

		// When
		const result = renderJsonTreeLines(value, undefined, 6, 2, 40);

		// Then
		expect(result.lines).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});

	it("truncates long scalar strings to the configured length", () => {
		// Given
		const value = { message: "abcdefghijklmnopqrstuvwxyz" };

		// When
		const result = renderJsonTreeLines(value, undefined, 6, 20, 10);

		// Then
		expect(result.lines.join("\n")).toContain("…");
	});

	it("renders plain text when no theme is supplied", () => {
		// Given
		const value = { active: true };

		// When
		const result = renderJsonTreeLines(value, undefined, 6, 20, 40);

		// Then
		expect(result.lines.join("\n")).not.toMatch(/\u001b\[/);
		expect(result.lines.join("\n")).toContain("active");
	});

	it("handles circular references without throwing", () => {
		// Given
		const value: { a: number; self?: unknown } = { a: 1 };
		value.self = value;

		// When
		const result = renderJsonTreeLines(value, undefined, 3, 20, 40);

		// Then
		expect(result.lines.length).toBeGreaterThan(0);
		expect(result.lines.join("\n")).toContain("…");
	});
});
