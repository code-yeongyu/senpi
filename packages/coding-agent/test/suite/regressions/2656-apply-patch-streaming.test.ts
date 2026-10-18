import { describe, expect, test } from "vitest";
import { renderStreamingPatchCall } from "../../../src/core/extensions/builtin/gpt-apply-patch/streaming-render.ts";
import type {
	ApplyPatchRenderState,
	ApplyPatchTheme,
} from "../../../src/core/extensions/builtin/gpt-apply-patch/types.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/2656

const THEME: ApplyPatchTheme = {
	fg: (_c, t) => t,
	bg: (_c, t) => t,
	bold: (t) => t,
	inverse: (t) => t,
};

function render(container: { render(width: number): string[] } | undefined, width = 120): string {
	return container === undefined ? "" : container.render(width).flat().join("\n");
}

const MANY_LINES = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`).join("\n");

function patchFor(files: Array<{ path: string; body: string }>): string {
	const parts = files.map((f) => `*** Add File: ${f.path}\n${f.body}`);
	return `*** Begin Patch\n${parts.join("\n")}\n*** End Patch\n`;
}

describe("apply_patch streaming render is bounded and incremental", () => {
	test("a long file is tail-windowed with a +N lines above marker, not an unbounded box", () => {
		const state: ApplyPatchRenderState = {};
		const input = patchFor([{ path: "src/big.ts", body: MANY_LINES }]);
		const out = render(renderStreamingPatchCall({ input }, THEME, state));

		expect(out).toContain("• Added src/big.ts");
		expect(out).toMatch(/\+2[0-9] lines above/);
		expect(out).toContain("line 40");
		// The first lines are windowed out, so the box stays short.
		expect(out).not.toContain("+line 1\n");
		expect(out).not.toContain("+line 5\n");
	});

	test("the sticky header carries net +a -d counts", () => {
		const state: ApplyPatchRenderState = {};
		const input = patchFor([{ path: "src/a.ts", body: "+one\n+two\n+three" }]);
		const out = render(renderStreamingPatchCall({ input }, THEME, state));
		expect(out).toContain("• Added src/a.ts (+3 -0)");
	});

	test("an update hunk's header counts only real changes, not context lines", () => {
		const state: ApplyPatchRenderState = {};
		const input = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			"@@ context1",
			" context1",
			"-old line",
			"+new line",
			" context2",
			"*** End Patch",
		].join("\n");
		const out = render(renderStreamingPatchCall({ input }, THEME, state));
		// One real change (one removed, one added); the two context lines are not counted.
		expect(out).toContain("• Edited src/a.ts (+1 -1)");
	});

	test("a pure insert does not miscount context as a removal", () => {
		const state: ApplyPatchRenderState = {};
		// Insert one line in the middle; no line is removed. oldLines == newLines minus the insert.
		const input = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			" ctx1",
			"+inserted line",
			" ctx2",
			"*** End Patch",
		].join("\n");
		const out = render(renderStreamingPatchCall({ input }, THEME, state));
		// Only the insert counts; the context lines are unchanged on both sides.
		expect(out).toContain("• Edited src/a.ts (+1 -0)");
	});

	test("a pure delete does not miscount context as an addition", () => {
		const state: ApplyPatchRenderState = {};
		const input = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			" ctx1",
			"-removed line",
			" ctx2",
			"*** End Patch",
		].join("\n");
		const out = render(renderStreamingPatchCall({ input }, THEME, state));
		expect(out).toContain("• Edited src/a.ts (+0 -1)");
	});

	test("a + line whose text equals a context line still counts as an addition", () => {
		const state: ApplyPatchRenderState = {};
		// The added line's text is identical to an existing context line; a set-based count would
		// treat it as context and report (+0 -0), but it is a real insertion.
		const input = ["*** Begin Patch", "*** Update File: src/a.ts", " ctx1", "+ctx1", " ctx2", "*** End Patch"].join(
			"\n",
		);
		const out = render(renderStreamingPatchCall({ input }, THEME, state));
		expect(out).toContain("• Edited src/a.ts (+1 -0)");
	});

	test("a delta that changes nothing keeps the rendered box instead of blanking it", () => {
		const state: ApplyPatchRenderState = {};
		const input = patchFor([{ path: "src/a.ts", body: "+one" }]);
		const first = render(renderStreamingPatchCall({ input }, THEME, state));
		expect(first).toContain("• Added src/a.ts");
		// Same input again: the box still renders (a redraw must not blank the preview).
		const second = render(renderStreamingPatchCall({ input }, THEME, state));
		expect(second).toContain("• Added src/a.ts");
	});

	test("an in-flight partial line renders as the last dimmed row", () => {
		const state: ApplyPatchRenderState = {};
		// No trailing newline after the last + line, so it is still in flight.
		const input = `*** Begin Patch\n*** Add File: src/a.ts\n+done\n+in progress`;
		const out = render(renderStreamingPatchCall({ input }, THEME, state));
		expect(out).toContain("in progress");
	});
});
