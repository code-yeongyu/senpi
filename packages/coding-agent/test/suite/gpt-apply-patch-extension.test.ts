import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertResponsesTools } from "../../../ai/src/providers/openai-responses-shared.js";
import gptApplyPatchExtension, {
	APPLY_PATCH_FREEFORM_DESCRIPTION,
	APPLY_PATCH_LARK_GRAMMAR,
	createApplyPatchTool,
	isOpenAIGptModel,
} from "../../src/core/extensions/builtin/gpt-apply-patch/index.js";
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
		const registeredTool = capturedTool;
		if (!registeredTool) {
			throw new Error("apply_patch tool was not registered");
		}
		expect(registeredTool.name).toBe("apply_patch");
		expect(registeredTool.label).toBe("ApplyPatch");
		expect(registeredTool.description).toBe(APPLY_PATCH_FREEFORM_DESCRIPTION);
		expect(registeredTool.parameters).toMatchObject({
			type: "object",
			required: ["input"],
			properties: {
				input: {
					type: "string",
					description: "The entire contents of the apply_patch command",
				},
			},
		});
		expect(registeredTool.prepareArguments?.("*** Begin Patch\n*** End Patch")).toEqual({
			input: "*** Begin Patch\n*** End Patch",
		});
		expect(registeredTool.prepareArguments?.({ input: "*** Begin Patch\n*** End Patch" })).toEqual({
			input: "*** Begin Patch\n*** End Patch",
		});
		expect(registeredTool.freeform).toEqual({
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		});

		const [wireTool] = convertResponsesTools([registeredTool]);
		expect(wireTool).not.toHaveProperty("parameters");
		expect(wireTool).not.toHaveProperty("strict");
	});

	it("identifies only OpenAI GPT-family models", () => {
		expect(isOpenAIGptModel({ provider: "openai", id: "gpt-5" } as { provider: string; id: string })).toBe(true);
		expect(isOpenAIGptModel({ provider: "openai", id: "gpt-4o-mini" } as { provider: string; id: string })).toBe(
			true,
		);
		expect(isOpenAIGptModel({ provider: "openai", id: "o1" } as { provider: string; id: string })).toBe(false);
		expect(isOpenAIGptModel({ provider: "anthropic", id: "gpt-5" } as { provider: string; id: string })).toBe(false);
	});

	it("recognises GPT models hosted on Azure and GitHub Copilot providers", () => {
		expect(
			isOpenAIGptModel({ provider: "azure-openai-responses", id: "gpt-5.2" } as { provider: string; id: string }),
		).toBe(true);
		expect(
			isOpenAIGptModel({ provider: "azure-openai-responses", id: "gpt-5.5" } as { provider: string; id: string }),
		).toBe(true);
		expect(isOpenAIGptModel({ provider: "github-copilot", id: "gpt-5" } as { provider: string; id: string })).toBe(
			true,
		);
		expect(
			isOpenAIGptModel({ provider: "azure-openai-responses", id: "o1" } as { provider: string; id: string }),
		).toBe(false);
		expect(
			isOpenAIGptModel({ provider: "github-copilot", id: "claude-sonnet-4-5" } as {
				provider: string;
				id: string;
			}),
		).toBe(false);
	});

	it("exposes a codex-style promptSnippet and promptGuidelines on the apply_patch tool", () => {
		const tool = createApplyPatchTool();

		expect(typeof tool.promptSnippet).toBe("string");
		expect(tool.promptSnippet ?? "").toMatch(/apply_patch/);

		const guidelines = tool.promptGuidelines ?? [];
		expect(Array.isArray(guidelines)).toBe(true);
		expect(guidelines.length).toBeGreaterThanOrEqual(2);

		const joined = guidelines.join("\n");
		expect(joined).toMatch(/apply_patch/);
		// Codex GPT-5.2 guard: ban inline python/heredoc-driven file mutation through bash.
		expect(joined.toLowerCase()).toMatch(/python/);
		// Codex GPT-5.2 guard: do not waste tokens re-reading after a successful patch.
		expect(joined.toLowerCase()).toMatch(/re-?read|do not.*read/);
	});

	it("applies Codex-format patches from JSON input to files", async () => {
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

	it("applies Codex-format patches from raw freeform input to files", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const targetPath = path.join(harness.tempDir, "raw.txt");
		await writeFile(targetPath, "before\n", "utf-8");
		const tool = createApplyPatchTool();

		await tool.execute(
			"call-1",
			`*** Begin Patch
*** Update File: raw.txt
@@
-before
+after
*** End Patch` as never,
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
