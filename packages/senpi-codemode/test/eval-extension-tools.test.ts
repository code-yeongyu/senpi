import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import registerApplyPatchExtension from "../../coding-agent/src/core/extensions/builtin/gpt-apply-patch/extension.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type LazyToolActivator = (toolName: string) => boolean;

const PATCH_SENTINEL = "extension apply_patch reached";

function createApplyPatchEvalHarness(model: { readonly api: string; readonly id: string }) {
	type ApplyPatchExtensionApi = Parameters<typeof registerApplyPatchExtension>[0];
	type ApplyPatchToolDefinition = Parameters<ApplyPatchExtensionApi["registerTool"]>[0];
	type ModelSelectHandler = (
		event: { model: { readonly api: string; readonly id: string } },
		context: unknown,
	) => unknown;
	const handlers = new Map<string, unknown>();
	function isModelSelectHandler(value: unknown): value is ModelSelectHandler {
		return typeof value === "function";
	}
	const registeredTools = new Map<string, ApplyPatchToolDefinition>();
	let activeToolNames: string[] = [];
	let lazyToolActivator: LazyToolActivator | undefined;
	const api: ApplyPatchExtensionApi = {
		registerTool(tool: ApplyPatchToolDefinition) {
			registeredTools.set(tool.name, tool);
		},
		registerLazyToolActivator(activate: LazyToolActivator) {
			lazyToolActivator = activate;
		},
		getActiveTools: () => [...activeToolNames],
		getAllTools: () => {
			throw new Error("getAllTools is not used by this test");
		},
		setActiveTools(toolNames: string[]) {
			activeToolNames = [...toolNames];
		},
		on(event, handler) {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		},
	};
	registerApplyPatchExtension(api);

	const selectModel = async () => {
		const stored = handlers.get("model_select");
		if (!isModelSelectHandler(stored)) throw new Error("apply_patch extension did not register model_select");
		await stored({ model }, { model });
	};
	const executeTool = async (toolName: string): Promise<AgentToolResult<unknown>> => {
		if (!registeredTools.has(toolName)) throw new Error(`Unknown tool ${toolName}`);
		if (!activeToolNames.includes(toolName) && lazyToolActivator?.(toolName) !== true) {
			throw new Error(`Tool ${toolName} is registered but inactive. Active tools: ${activeToolNames.join(", ")}`);
		}
		return { content: [{ type: "text", text: PATCH_SENTINEL }], details: {} };
	};

	return { executeTool, selectModel };
}

async function invokeApplyPatchThroughEval(
	harness: ReturnType<typeof createApplyPatchEvalHarness>,
	cellId: string,
): Promise<FakeKernel> {
	await harness.selectModel();
	const kernel = new FakeKernel([
		{
			type: "tool-call",
			callId: `${cellId}-call`,
			toolName: "apply_patch",
			args: { input: "*** Begin Patch\n*** End Patch" },
		},
		result(cellId, "done"),
	]);
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool: harness.executeTool,
	});
	await tool.execute(
		cellId,
		{
			language: "js",
			code: "await tool.apply_patch({input: patch})",
			summary: "Invoke the extension-provided apply_patch tool through eval",
		},
		undefined,
		undefined,
		fakeExtensionContext(),
	);
	return kernel;
}

describe("eval extension tools", () => {
	it("calls an eligible inactive apply_patch extension tool through eval", async () => {
		const harness = createApplyPatchEvalHarness({
			api: "openai-responses",
			id: "gpt-5.6-sol",
		});
		const kernel = await invokeApplyPatchThroughEval(harness, "extension-cell");

		expect(kernel.replies).toContainEqual({
			type: "tool-reply",
			callId: "extension-cell-call",
			ok: true,
			value: { text: PATCH_SENTINEL },
		});
	});

	it("keeps apply_patch inactive for an ineligible model", async () => {
		const harness = createApplyPatchEvalHarness({
			api: "anthropic-messages",
			id: "claude-fable-5",
		});
		const kernel = await invokeApplyPatchThroughEval(harness, "ineligible-cell");

		expect(kernel.replies).toContainEqual({
			type: "tool-reply",
			callId: "ineligible-cell-call",
			ok: false,
			error: {
				message: "Tool apply_patch is registered but inactive. Active tools: ",
			},
		});
	});
});
