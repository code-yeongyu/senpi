import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertResponsesTools } from "../../../ai/src/providers/openai-responses-shared.ts";
import gptApplyPatchExtension, {
	APPLY_PATCH_FREEFORM_DESCRIPTION,
	APPLY_PATCH_LARK_GRAMMAR,
	applyPatchDetailed,
	createApplyPatchTool,
	isOpenAIGptModel,
} from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import type { ToolDefinition, ToolRenderContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import type { Harness } from "./harness.ts";
import { createHarness } from "./harness.ts";

type ApplyPatchTool = ReturnType<typeof createApplyPatchTool>;
type ApplyPatchUpdate = Parameters<NonNullable<Parameters<ApplyPatchTool["execute"]>[3]>>[0];

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
		expect(isOpenAIGptModel({ api: "openai-responses", id: "gpt-5" } as { api: string; id: string })).toBe(true);
		expect(isOpenAIGptModel({ api: "openai-responses", id: "gpt-4o-mini" } as { api: string; id: string })).toBe(
			true,
		);
		expect(isOpenAIGptModel({ api: "openai-responses", id: "o1" } as { api: string; id: string })).toBe(false);
		expect(isOpenAIGptModel({ api: "anthropic-messages", id: "gpt-5" } as { api: string; id: string })).toBe(false);
	});

	it("recognises GPT models hosted on Azure and GitHub Copilot providers", () => {
		expect(isOpenAIGptModel({ api: "azure-openai-responses", id: "gpt-5.2" } as { api: string; id: string })).toBe(
			true,
		);
		expect(isOpenAIGptModel({ api: "azure-openai-responses", id: "gpt-5.5" } as { api: string; id: string })).toBe(
			true,
		);
		// github-copilot serves modern GPT models via the Responses API.
		expect(isOpenAIGptModel({ api: "openai-responses", id: "gpt-5" } as { api: string; id: string })).toBe(true);
		expect(isOpenAIGptModel({ api: "azure-openai-responses", id: "o1" } as { api: string; id: string })).toBe(false);
		expect(
			isOpenAIGptModel({ api: "openai-responses", id: "claude-sonnet-4-5" } as { api: string; id: string }),
		).toBe(false);
	});

	it("enables apply_patch for OpenAI-compatible custom providers using the Responses API", () => {
		// Regression: custom providers (e.g. quotio-openai/gpt-5.5-fast) proxy OpenAI via
		// openai-responses. The gate must key off the API, not a provider allowlist.
		expect(isOpenAIGptModel({ api: "openai-responses", id: "gpt-5.5-fast" } as { api: string; id: string })).toBe(
			true,
		);
		expect(isOpenAIGptModel({ api: "openai-codex-responses", id: "gpt-5.5" } as { api: string; id: string })).toBe(
			true,
		);
		// Completions API cannot carry freeform tools, so apply_patch must stay disabled even
		// for gpt-* ids (e.g. github-copilot/gpt-4.1).
		expect(isOpenAIGptModel({ api: "openai-completions", id: "gpt-4.1" } as { api: string; id: string })).toBe(false);
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

	it("renders a pending apply_patch update as a Codex-style TUI diff widget", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "sample.txt"), "before\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** Add File: created.txt
+created
*** End Patch`;
		const tool = createApplyPatchTool();
		let pendingUpdate: ApplyPatchUpdate | undefined;

		await tool.execute(
			"call-preview",
			{ input: patch },
			undefined,
			(update) => {
				pendingUpdate ??= update;
			},
			{ cwd: harness.tempDir } as Parameters<typeof tool.execute>[4],
		);

		if (!pendingUpdate) {
			throw new Error("apply_patch did not emit a pending update");
		}

		const firstText = pendingUpdate.content.find((block) => block.type === "text")?.text ?? "";
		expect(firstText).toContain("Applying patch (0/2)...\n• Edited 2 files (+2 -1)");
		expect(firstText).toContain("sample.txt (+1 -1)");
		expect(firstText).toContain("-1 before");
		expect(firstText).toContain("+1 after");
		expect(firstText).toContain("created.txt (+1 -0)");
		expect(firstText).toContain("+1 created");
		expect(firstText).not.toContain("Index:");

		const renderContext = {
			args: { input: patch },
			toolCallId: "call-preview",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: harness.tempDir,
			executionStarted: true,
			argsComplete: true,
			isPartial: true,
			expanded: false,
			showImages: true,
			isError: false,
		} satisfies ToolRenderContext<Record<string, never>, { input: string }>;

		const callComponent = tool.renderCall?.({ input: patch }, theme, renderContext);
		const component = tool.renderResult?.(
			{ content: pendingUpdate.content, details: pendingUpdate.details },
			{ expanded: false, isPartial: true },
			theme,
			renderContext,
		);
		const renderedCall = stripAnsi(callComponent?.render(120).join("\n") ?? "");
		const rendered = stripAnsi(component?.render(120).join("\n") ?? "");
		expect(renderedCall).toContain("apply_patch");
		expect(rendered).toContain("Applying patch");
		expect(rendered).toContain("• Edited 2 files (+2 -1)");
		expect(rendered).toContain("sample.txt (+1 -1)");
		expect(rendered).toContain("+1 after");
		expect(rendered).not.toContain("Index:");
	});

	it("emits realtime progress updates while applying multiple patch operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "first.txt"), "one\n", "utf-8");
		await writeFile(path.join(harness.tempDir, "second.txt"), "two\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: first.txt
@@
-one
+ONE
*** Update File: second.txt
@@
-two
+TWO
*** End Patch`;
		const tool = createApplyPatchTool();
		const updates: ApplyPatchUpdate[] = [];

		await tool.execute(
			"call-progress",
			{ input: patch },
			undefined,
			(update) => {
				updates.push(update);
			},
			{ cwd: harness.tempDir } as Parameters<typeof tool.execute>[4],
		);

		expect(updates).toHaveLength(3);
		expect(updates[0]?.details?.progress).toEqual({ applied: 0, failed: 0, total: 2 });
		expect(updates[1]?.details?.progress).toEqual({ applied: 1, failed: 0, total: 2 });
		expect(updates[2]?.details?.progress).toEqual({ applied: 2, failed: 0, total: 2 });
		expect(updates[1]?.content.find((block) => block.type === "text")?.text).toContain("Applying patch (1/2)...");
		expect(updates[2]?.content.find((block) => block.type === "text")?.text).toContain("Applying patch (2/2)...");
		expect(await readFile(path.join(harness.tempDir, "first.txt"), "utf-8")).toBe("ONE\n");
		expect(await readFile(path.join(harness.tempDir, "second.txt"), "utf-8")).toBe("TWO\n");
	});

	it("continues applying operations when progress rendering throws", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "first.txt"), "one\n", "utf-8");
		await writeFile(path.join(harness.tempDir, "second.txt"), "two\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: first.txt
@@
-one
+ONE
*** Update File: second.txt
@@
-two
+TWO
*** End Patch`;

		const result = await applyPatchDetailed(harness.tempDir, patch, () => {
			throw new Error("render failed");
		});

		expect(result.failures).toEqual([]);
		expect(result.appliedFiles).toEqual(["first.txt", "second.txt"]);
		expect(await readFile(path.join(harness.tempDir, "first.txt"), "utf-8")).toBe("ONE\n");
		expect(await readFile(path.join(harness.tempDir, "second.txt"), "utf-8")).toBe("TWO\n");
	});

	it("applies absolute and parent-escaping paths", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const tool = createApplyPatchTool();
		const outsideParentName = `${path.basename(harness.tempDir)}-parent.txt`;
		const outsideParentPath = path.join(path.dirname(harness.tempDir), outsideParentName);
		const absoluteOutsidePath = path.join(
			path.dirname(harness.tempDir),
			`${path.basename(harness.tempDir)}-absolute.txt`,
		);

		try {
			const result = await tool.execute(
				"call-1",
				{
					input: `*** Begin Patch
*** Add File: ../${outsideParentName}
+escape
*** Add File: ${absoluteOutsidePath}
+absolute
*** End Patch`,
				},
				undefined,
				undefined,
				{ cwd: harness.tempDir } as Parameters<typeof tool.execute>[4],
			);

			expect(result.content.find((block) => block.type === "text")?.text).toContain(`add: ../${outsideParentName}`);
			expect(await readFile(outsideParentPath, "utf-8")).toBe("escape\n");
			expect(await readFile(absoluteOutsidePath, "utf-8")).toBe("absolute\n");
		} finally {
			await rm(outsideParentPath, { force: true });
			await rm(absoluteOutsidePath, { force: true });
		}
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
