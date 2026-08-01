import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyPatchDetailed,
	buildPartialFailureText,
} from "../../src/core/extensions/builtin/gpt-apply-patch/apply.ts";
import { registerApplyPatchExtension } from "../../src/core/extensions/builtin/gpt-apply-patch/extension.ts";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import type { ApplyPatchExtensionAPI } from "../../src/core/extensions/builtin/gpt-apply-patch/types.ts";
import type { ExtensionHandler, ToolResultEvent, ToolResultEventResult } from "../../src/core/extensions/types.ts";
import type { Harness } from "./harness.ts";
import { createHarness } from "./harness.ts";

const harnesses: Harness[] = [];
type ToolResultHandler = ExtensionHandler<ToolResultEvent, ToolResultEventResult>;

function captureToolResultHandler(): ToolResultHandler {
	let toolResultHandler: ToolResultHandler | undefined;
	const api = {
		registerTool: () => {},
		on: (event: string, handler: unknown) => {
			if (event === "tool_result") toolResultHandler = handler as ToolResultHandler;
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
	} as unknown as ApplyPatchExtensionAPI;
	registerApplyPatchExtension(api);
	if (!toolResultHandler) throw new Error("apply_patch did not register a tool_result handler");
	return toolResultHandler;
}

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((h) => h.cleanup()));
});

describe("gpt-apply-patch failure disclosure (#31)", () => {
	it("surfaces the underlying failure message for a missing file (ENOENT)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const patch = `*** Begin Patch
*** Update File: missing.txt
@@
-old
+new
*** End Patch`;

		const result = await applyPatchDetailed(harness.tempDir, patch);

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]?.message).toContain("ENOENT");

		const text = buildPartialFailureText(result);
		expect(text).toContain("missing.txt");
		expect(text).not.toContain("MUST read");
	});

	it("surfaces the underlying failure message for a context mismatch and advises reread", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "exists.txt"), "line\n", "utf-8");

		const patch = `*** Begin Patch
*** Update File: exists.txt
@@
-missing
+new
*** End Patch`;

		const result = await applyPatchDetailed(harness.tempDir, patch);

		expect(result.failures).toHaveLength(1);
		const text = buildPartialFailureText(result);
		expect(text).toContain("exists.txt");
		expect(text).toContain("MUST read exists.txt");
		expect(text).toMatch(/expected lines|context|find/i);
	});

	it("discloses failure messages via tool execute for a complete failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "broken.txt"), "line\n", "utf-8");

		const patch = `*** Begin Patch
*** Update File: broken.txt
@@
-missing
+changed
*** End Patch`;

		const tool = createApplyPatchTool();
		const result = await tool.execute("apply-patch-test", { input: patch }, undefined, undefined, {
			cwd: harness.tempDir,
		} as never);

		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		expect(text).toContain("broken.txt");
		expect(text).toMatch(/expected lines|context|find/i);
	});

	it("marks partial patch failures as errors for the model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "existing.txt"), "actual\n", "utf-8");
		const patch = `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: existing.txt
@@
-expected
+changed
*** End Patch`;
		const tool = createApplyPatchTool();
		const result = await tool.execute("partial-failure", { input: patch }, undefined, undefined, {
			cwd: harness.tempDir,
		} as never);
		const hookResult = await captureToolResultHandler()(
			{
				type: "tool_result",
				toolName: "apply_patch",
				toolCallId: "partial-failure",
				input: { input: patch },
				content: result.content,
				details: result.details,
				isError: false,
			},
			{} as never,
		);

		expect(hookResult).toEqual({ isError: true });
	});

	it("marks complete patch failures as errors for the model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "existing.txt"), "actual\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: existing.txt
@@
-expected
+changed
*** End Patch`;
		const tool = createApplyPatchTool();
		const result = await tool.execute("complete-failure", { input: patch }, undefined, undefined, {
			cwd: harness.tempDir,
		} as never);

		const hookResult = await captureToolResultHandler()(
			{
				type: "tool_result",
				toolName: "apply_patch",
				toolCallId: "complete-failure",
				input: { input: patch },
				content: result.content,
				details: result.details,
				isError: false,
			},
			{} as never,
		);

		expect(hookResult).toEqual({ isError: true });
	});
});

describe("gpt-apply-patch mutation queue (#28)", () => {
	it("serializes concurrent patches to the same file", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "shared.txt"), "first\nsecond\n", "utf-8");

		const firstPatch = `*** Begin Patch
*** Update File: shared.txt
@@
-first
+FIRST
*** End Patch`;

		const secondPatch = `*** Begin Patch
*** Update File: shared.txt
@@
-second
+SECOND
*** End Patch`;

		await Promise.all([
			applyPatchDetailed(harness.tempDir, firstPatch),
			applyPatchDetailed(harness.tempDir, secondPatch),
		]);

		const content = await readFile(path.join(harness.tempDir, "shared.txt"), "utf-8");
		expect(content).toBe("FIRST\nSECOND\n");
	});
});
