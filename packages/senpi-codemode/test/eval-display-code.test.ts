import { describe, expect, it } from "vitest";
import { displayCode } from "../src/tool/display-code.ts";
import { prettifyJs } from "../src/tool/display-js.ts";
import { renderEvalCall } from "../src/tool/render.ts";
import { DENSE_JS_CELL } from "./eval-display-fixtures.ts";
import { callContext, renderLines } from "./eval-render-fixtures.ts";

// Vitest runs this package on Node; the Bun layout is covered by eval-display-code-bun.test.ts.
describe("displayCode on Node", () => {
	it("runs under Node, where no Bun printer exists", () => {
		expect(process.versions.bun).toBeUndefined();
	});

	it("shows a dense JavaScript cell exactly as sent", () => {
		expect(displayCode(DENSE_JS_CELL, "js")).toBe(DENSE_JS_CELL);
	});

	it("shows Ruby, Julia, and callback-less Python cells as sent", () => {
		const python = `rows = [r for r in data if r["kind"] == "x"]; print(len(rows)); print(rows[:3]); print(sum(r["n"] for r in rows))`;
		const ruby = `rows = data.select { |r| r["kind"] == "x" }; puts rows.length; puts rows.first(3).inspect; puts rows.sum { |r| r["n"] }`;
		expect(displayCode(python, "py")).toBe(python);
		expect(displayCode(ruby, "rb")).toBe(ruby);
		expect(displayCode(ruby, "jl")).toBe(ruby);
	});

	it("renders the cell frame with the code as sent", () => {
		const component = renderEvalCall(
			{ language: "js", code: DENSE_JS_CELL, summary: "Reading the dense cell preview" },
			undefined,
			callContext({ spinnerFrame: 0, expanded: true }),
		);
		const lines = renderLines(component);
		expect(lines.some((line) => line.startsWith("\u2502 for(let i=0;i<4;i++){print("))).toBe(true);
		expect(lines).not.toContain("\u2502 for (let i = 0; i < 4; i++) {");
	});
});

describe("prettifyJs equivalence guard", () => {
	it("shows a cell as sent when the printer's layout regroups an expression", () => {
		const code = "total = (first(), second()); print(total)";
		const dropsGrouping = (masked: string) => masked.replace("(", "").replace("))", ")");
		expect(prettifyJs(code, dropsGrouping)).toBeUndefined();
	});

	it("accepts a printer that only changes whitespace and semicolons", () => {
		const code = "total = (first(), second()); print(total)";
		expect(prettifyJs(code, (masked) => masked.replace("; ", ";\n"))).toBe(
			"total = (first(), second());\nprint(total)",
		);
	});
});
