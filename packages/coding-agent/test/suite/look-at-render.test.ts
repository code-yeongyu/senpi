import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	type LookAtRenderArgs,
	type LookAtToolDetails,
	renderLookAtCall,
	renderLookAtResult,
} from "../../src/core/extensions/builtin/look-at/render.ts";
import type { ToolRenderContext } from "../../src/core/extensions/types.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const theme = {
	bold: (value: string) => value,
	fg: (_key: string, value: string) => value,
} as Theme;

function render(component: Component): string {
	return component.render(160).join("\n");
}

function renderContext(harness: Harness, args: LookAtRenderArgs): ToolRenderContext<unknown, LookAtRenderArgs> {
	return {
		args,
		toolCallId: "look-at-render",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: harness.tempDir,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

describe("look_at renderers", () => {
	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("renders source labels, a shortened goal, and the selected vision model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const args: LookAtRenderArgs = {
			file_paths: ["assets/receipt.png", "attachment://2"],
			image_data: "iVBORw0KGgo=",
			goal: `Summarize every visible total and compare it with the invoice. ${"detail ".repeat(20)}`,
		};
		const context = renderContext(harness, args);

		const call = render(renderLookAtCall(args, theme, context));
		expect(call).toContain("look_at");
		expect(call).toContain("receipt.png");
		expect(call).toContain("Image #2");
		expect(call).toContain("base64 input");
		expect(call).toContain("…");

		const details: LookAtToolDetails = {
			model: "google/gemini-3.1-pro-preview",
			sources: ["receipt.png", "Image #2", "base64 input"],
			mimeTypes: ["image/png", "image/png", "image/png"],
		};
		const result = {
			content: [{ type: "text", text: "first\nsecond\nthird\nfourth\nfifth" }],
			details,
		};
		const collapsed = render(renderLookAtResult(result, { expanded: false, isPartial: false }, theme, context));
		const expanded = render(renderLookAtResult(result, { expanded: true, isPartial: false }, theme, context));

		expect(collapsed).toContain("google/gemini-3.1-pro-preview");
		expect(collapsed).toContain("fourth");
		expect(collapsed).not.toContain("fifth");
		expect(expanded).toContain("fifth");
	});

	it("renders a basic partial result when details are not available yet", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const args: LookAtRenderArgs = { file_path: "diagram.png", goal: "Describe the labels" };

		expect(() =>
			render(
				renderLookAtResult(
					{ content: [] },
					{ expanded: false, isPartial: true },
					theme,
					renderContext(harness, args),
				),
			),
		).not.toThrow();
	});
});
