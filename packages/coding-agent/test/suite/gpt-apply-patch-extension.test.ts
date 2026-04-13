import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import gptApplyPatchExtension, {
	APPLY_PATCH_FREEFORM_DESCRIPTION,
	APPLY_PATCH_LARK_GRAMMAR,
	createApplyPatchTool,
	isOpenAIGptModel,
} from "../../src/core/extensions/builtin/gpt-apply-patch.js";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.js";
import type { ToolDefinition } from "../../src/core/extensions/index.js";
import type { Harness } from "./harness.js";
import { createHarness } from "./harness.js";

describe("gpt-apply-patch builtin extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("registers an apply_patch tool matching the Codex schema and description", async () => {
		let capturedTool: ToolDefinition | undefined;

		gptApplyPatchExtension({
			registerTool(tool: ToolDefinition) {
				capturedTool = tool;
			},
			on() {},
		} as never);

		expect(capturedTool).toBeDefined();
		expect(capturedTool?.name).toBe("apply_patch");
		expect(capturedTool?.label).toBe("ApplyPatch");
		expect(capturedTool?.description).toBe(APPLY_PATCH_FREEFORM_DESCRIPTION);
		expect(capturedTool?.parameters).toMatchObject({
			type: "object",
			required: ["input"],
			properties: {
				input: {
					type: "string",
					description: "The entire contents of the apply_patch command",
				},
			},
		});
		expect(capturedTool?.freeform).toEqual({
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		});
	});

	it("identifies only OpenAI GPT-family models", () => {
		expect(isOpenAIGptModel({ provider: "openai", id: "gpt-5" } as { provider: string; id: string })).toBe(true);
		expect(isOpenAIGptModel({ provider: "openai", id: "gpt-4o-mini" } as { provider: string; id: string })).toBe(
			true,
		);
		expect(isOpenAIGptModel({ provider: "openai", id: "o1" } as { provider: string; id: string })).toBe(false);
		expect(isOpenAIGptModel({ provider: "anthropic", id: "gpt-5" } as { provider: string; id: string })).toBe(false);
	});

	it("applies Codex-format patches to files", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const targetPath = path.join(harness.tempDir, "sample.txt");
		await writeFile(targetPath, "before\n", "utf-8");
		const tool = createApplyPatchTool();

		await tool.execute(
			"call-1",
			{
				input: `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** End Patch`,
			},
			undefined,
			undefined,
			{ cwd: harness.tempDir } as Parameters<typeof tool.execute>[4],
		);

		expect(await readFile(targetPath, "utf-8")).toBe("after\n");
	});

	it("rejects absolute and parent-escaping paths", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const tool = createApplyPatchTool();

		await expect(
			tool.execute(
				"call-1",
				{
					input: `*** Begin Patch
*** Add File: ../outside.txt
+escape
*** End Patch`,
				},
				undefined,
				undefined,
				{ cwd: harness.tempDir } as Parameters<typeof tool.execute>[4],
			),
		).rejects.toThrow("within the current workspace");
	});

	it("replaces write and edit with apply_patch for OpenAI GPT models from session start", async () => {
		let providerToolNames: string[] = [];
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: "gpt-5", reasoning: true },
				{ id: "o1", reasoning: true },
			],
			extensionFactories: [gptApplyPatchExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			(context) => {
				providerToolNames = (context.tools ?? []).map((tool) => tool.name);
				return {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
			},
		]);

		await harness.session.prompt("test");

		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "apply_patch"]);
		expect(providerToolNames).toEqual(["read", "bash", "apply_patch"]);
	});

	it("restores write and edit when the session switches away from an OpenAI GPT model", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: "gpt-5", reasoning: true },
				{ id: "o1", reasoning: true },
			],
			extensionFactories: [gptApplyPatchExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		expect(harness.session.getActiveToolNames()).toContain("apply_patch");

		await harness.session.setModel(harness.getModel("o1")!);

		expect(harness.session.getActiveToolNames()).toContain("write");
		expect(harness.session.getActiveToolNames()).toContain("edit");
		expect(harness.session.getActiveToolNames()).not.toContain("apply_patch");

		await harness.session.setModel(harness.getModel("gpt-5")!);

		expect(harness.session.getActiveToolNames()).toContain("apply_patch");
		expect(harness.session.getActiveToolNames()).not.toContain("write");
		expect(harness.session.getActiveToolNames()).not.toContain("edit");
	});

	it("preserves toolset changes made while on a GPT model when restoring non-GPT tools", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: "gpt-5", reasoning: true },
				{ id: "o1", reasoning: true },
			],
			extensionFactories: [gptApplyPatchExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		harness.session.setActiveToolsByName(["read", "bash", "grep", "apply_patch"]);
		await harness.session.setModel(harness.getModel("o1")!);

		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "grep", "edit", "write"]);
	});

	it("extracts file-scoped edit permissions from apply_patch input", () => {
		const parserRegistry = createBuiltinParserRegistry();

		expect(
			parserRegistry.parse(
				"apply_patch",
				{
					input: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Add File: src/new.ts
+content
*** End Patch`,
				},
				"/tmp",
			),
		).toEqual([
			{ permission: "edit", patterns: ["src/app.ts"], always: ["src/app.ts"] },
			{ permission: "edit", patterns: ["src/new.ts"], always: ["src/new.ts"] },
		]);
	});

	it("leaves non-OpenAI models on the default write/edit toolset", async () => {
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			models: [{ id: "claude-sonnet-4-5", reasoning: true }],
			extensionFactories: [gptApplyPatchExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		expect(harness.session.getActiveToolNames()).toContain("write");
		expect(harness.session.getActiveToolNames()).toContain("edit");
		expect(harness.session.getActiveToolNames()).not.toContain("apply_patch");
	});
});
