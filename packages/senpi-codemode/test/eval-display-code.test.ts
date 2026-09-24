import { describe, expect, it } from "vitest";
import { displayCode } from "../src/tool/display-code.ts";
import { renderEvalCall } from "../src/tool/render.ts";
import { callContext, renderLines } from "./eval-render-fixtures.ts";

// The shape models send: semicolon-joined statements on one line (senpi#2050).
const DENSE_CELL =
	'for(let i=0;i<4;i++){print("=== "+i+" ===");print(groupingWave[i].text.split("\\n\\nAdditional")[0]);} const d=await parallel([()=>tool.grep({pattern:"goal-cache|rule-activation",path:"/repo/apps",limit:80}),()=>tool.read({path:"/repo/notes.md"})]);for(let i=0;i<d.length;i++){print(d[i].text)}';

describe("displayCode", () => {
	it("breaks dense JS at statement, block, and long-array boundaries, keeping every token", () => {
		expect(displayCode(DENSE_CELL, "js")).toBe(
			[
				"for(let i=0;i<4;i++){",
				'  print("=== "+i+" ===");',
				'  print(groupingWave[i].text.split("\\n\\nAdditional")[0]);',
				"}",
				"const d=await parallel([",
				'  ()=>tool.grep({pattern:"goal-cache|rule-activation",path:"/repo/apps",limit:80}),',
				'  ()=>tool.read({path:"/repo/notes.md"})',
				"]);",
				"for(let i=0;i<d.length;i++){",
				"  print(d[i].text)",
				"}",
			].join("\n"),
		);
	});

	it("accepts the kernel's top-level await and return", () => {
		const code = `const a=await load("/repo/some/long/path/to/a/file.json");if(!a){print("missing input file, stopping");return 1}print(a)`;
		expect(displayCode(code, "js")).toBe(
			[
				'const a=await load("/repo/some/long/path/to/a/file.json");',
				"if(!a){",
				'  print("missing input file, stopping");',
				"  return 1",
				"}",
				"print(a)",
			].join("\n"),
		);
	});

	it("keeps comments between statements on their own lines", () => {
		const code = `const first=await tool.read({path:"/repo/a.md"}); /* then the second file */ const second=await tool.read({path:"/repo/b.md"});`;
		expect(displayCode(code, "js")).toBe(
			[
				'const first=await tool.read({path:"/repo/a.md"});',
				"/* then the second file */",
				'const second=await tool.read({path:"/repo/b.md"});',
			].join("\n"),
		);
	});

	it("returns unparseable, non-JS, and already readable code unchanged", () => {
		const broken = `const x = (${"a + ".repeat(40)}`;
		const python = `rows = [r for r in data if r["kind"] == "x"]; print(len(rows)); print(rows[:3]); print(sum(r["n"] for r in rows))`;
		const readable = "const x = 1;\nprint(x);";
		expect(displayCode(broken, "js")).toBe(broken);
		expect(displayCode(python, "py")).toBe(python);
		expect(displayCode(readable, "js")).toBe(readable);
	});

	it("renders the reformatted lines inside the eval cell frame", () => {
		const component = renderEvalCall(
			{ language: "js", code: DENSE_CELL, summary: "Working on the preview to read dense cells" },
			undefined,
			callContext({ spinnerFrame: 0, expanded: true }),
		);
		const lines = renderLines(component);
		expect(lines).toContain("\u2502 for(let i=0;i<4;i++){");
		expect(lines).toContain("\u2502   print(d[i].text)");
	});
});
