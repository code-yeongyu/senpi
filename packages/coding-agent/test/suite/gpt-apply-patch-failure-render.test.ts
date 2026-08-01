import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import type { ToolRenderContext } from "../../src/core/extensions/types.ts";
import type { Harness } from "./harness.ts";
import { createHarness } from "./harness.ts";

type ApplyPatchTool = ReturnType<typeof createApplyPatchTool>;
type ApplyPatchArgs = { input: string };

const markerTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	inverse: (text: string) => `<inverse>${text}</inverse>`,
};

function renderContext(cwd: string, args: ApplyPatchArgs) {
	return {
		args,
		toolCallId: "failed-patch",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: true,
		isError: true,
		hasResult: true,
	} satisfies ToolRenderContext<Record<string, unknown>, ApplyPatchArgs>;
}

describe("gpt apply_patch failure rendering", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
	});

	it("renders a partial failure instead of a successful patch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "existing.txt"), "actual\n", "utf-8");
		const args = {
			input: `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: existing.txt
@@
-expected
+changed
*** End Patch`,
		};
		const tool = createApplyPatchTool();
		const result = await tool.execute("partial-failure", args, undefined, undefined, {
			cwd: harness.tempDir,
		} as Parameters<ApplyPatchTool["execute"]>[4]);

		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			markerTheme as never,
			renderContext(harness.tempDir, args),
		);
		const rendered = component?.render(160).join("\n") ?? "";

		expect(rendered).toContain("<bg:toolErrorBg>");
		expect(rendered).toContain("<bold>Patch partially failed</bold>");
		expect(rendered).toContain("created.txt (+1 -0)");
		expect(rendered).toContain("existing.txt");
		expect(rendered).not.toContain("Applied patch");
		expect(rendered).not.toContain("Applying patch");
	});

	it("renders a complete failure as no file actions applied", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "existing.txt"), "actual\n", "utf-8");
		const args = {
			input: `*** Begin Patch
*** Update File: existing.txt
@@
-expected
+changed
*** End Patch`,
		};
		const tool = createApplyPatchTool();
		const result = await tool.execute("complete-failure", args, undefined, undefined, {
			cwd: harness.tempDir,
		} as Parameters<ApplyPatchTool["execute"]>[4]);

		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			markerTheme as never,
			renderContext(harness.tempDir, args),
		);
		const rendered = component?.render(160).join("\n") ?? "";

		expect(rendered).toContain("<bg:toolErrorBg>");
		expect(rendered).toContain("<bold>Patch failed</bold>");
		expect(rendered).toContain("No file actions were applied.");
		expect(rendered).not.toContain("Applying patch");
	});
});
