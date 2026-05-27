import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	type ApplyPatchParams,
	type ApplyPatchRenderState,
	createApplyPatchTool,
} from "../../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import type { ToolRenderContext } from "../../../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as TUI;
}

function renderApplyPatchCall(input: string): string {
	const givenTool = createApplyPatchTool();
	const givenRenderContext = {
		args: { input },
		toolCallId: "call-live-patch",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: false,
		isPartial: true,
		expanded: false,
		showImages: true,
		isError: false,
	} satisfies ToolRenderContext<ApplyPatchRenderState, ApplyPatchParams>;
	const whenComponent = givenTool.renderCall?.({ input }, theme, givenRenderContext);
	return stripAnsi(whenComponent?.render(120).join("\n") ?? "");
}

describe("TUI apply_patch rendering", () => {
	test("renders apply patch tool calls with live patch summary", () => {
		initTheme("dark");
		const givenPatch = `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** End Patch`;

		const whenRendered = renderApplyPatchCall(givenPatch);

		expect(whenRendered, "apply_patch call should render the live apply-patch surface").toContain("Applying patch");
		expect(whenRendered, "apply_patch call should summarize the touched file").toContain("• Edited sample.txt");
		expect(whenRendered, "apply_patch call should render changed lines as they stream").toContain("+ after");
	});

	test("renders malformed apply patch payload without crashing", () => {
		initTheme("dark");

		const whenRendered = renderApplyPatchCall("not a patch\n");

		expect(whenRendered, "malformed apply_patch input should render an error fallback").toContain(
			"Invalid patch stream",
		);
		expect(whenRendered, "malformed apply_patch input should preserve the parser message").toContain(
			"*** Begin Patch",
		);
	});

	test("keeps ordinary tool call rendering unchanged", () => {
		initTheme("dark");
		const givenComponent = new ToolExecutionComponent(
			"ordinary_tool",
			"call-ordinary-tool",
			{ foo: "bar" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		givenComponent.updateResult(
			{ content: [{ type: "text", text: "done" }], details: undefined, isError: false },
			false,
		);

		const whenRendered = stripAnsi(givenComponent.render(120).join("\n"));

		expect(whenRendered, "ordinary tool calls should still use the generic renderer").toContain("ordinary_tool");
		expect(whenRendered, "ordinary tool calls should still show JSON arguments").toContain('"foo": "bar"');
		expect(whenRendered, "ordinary tool calls should still show text output").toContain("done");
		expect(whenRendered, "ordinary tool calls should not use apply_patch framing").not.toContain("Applying patch");
	});
});
