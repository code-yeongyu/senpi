import { describe, expect, test } from "vitest";
import { countDiffChanges } from "../../../src/core/tools/diff-render.ts";
import { editRenderers } from "../../../src/core/tools/renderers/edit.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/2653

const THEME: any = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	inverse: (t: string) => t,
};

describe("countDiffChanges", () => {
	test("counts added and removed content lines, ignoring headers and context", () => {
		const diff = [
			"--- a/src/greet.ts",
			"+++ b/src/greet.ts",
			" 12  context line",
			"- 13  old line",
			"+ 13  new line",
			"+ 14  another new line",
			" 15  tail",
		].join("\n");
		expect(countDiffChanges(diff)).toEqual({ added: 2, removed: 1 });
	});

	test("returns zero counts for an empty diff", () => {
		expect(countDiffChanges("")).toEqual({ added: 0, removed: 0 });
	});
});

describe("edit card header", () => {
	test("shows the (+a/-d) change count next to the path", () => {
		const diff = ["- 13  old line", "+ 13  new line", "+ 14  another new line"].join("\n");
		const state: any = {
			callComponent: undefined,
		};
		// Pre-seed the preview diff so the header count renders synchronously.
		const context: any = {
			state,
			lastComponent: undefined,
			argsComplete: false,
			cwd: "/tmp/project",
			invalidate: () => {},
		};
		const component = editRenderers.renderCall!(
			{ path: "src/greet.ts", oldText: "old", newText: "new" },
			THEME,
			context,
		) as any;
		component.preview = { diff };
		const rebuilt = editRenderers.renderCall!({ path: "src/greet.ts", oldText: "old", newText: "new" }, THEME, {
			...context,
			lastComponent: component,
		}) as any;
		const text = rebuilt.render(120).flat().join("\n");
		expect(text).toContain("src/greet.ts");
		expect(text).toContain("(+2/-1)");
	});
});
