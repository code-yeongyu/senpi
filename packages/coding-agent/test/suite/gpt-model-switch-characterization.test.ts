import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import gptApplyPatchExtension from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function requiredModel(harness: Harness, modelId: string): Model<string> {
	const model = harness.getModel(modelId);
	if (!model) {
		throw new Error(`Missing characterization model: ${modelId}`);
	}
	return model;
}

function modelWithApi(harness: Harness, modelId: string, api: string): Model<string> {
	return { ...requiredModel(harness, modelId), api };
}

describe("GPT model-switch toolset characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("s1 swaps anthropic edit tools for apply_patch when selecting a Responses GPT", async () => {
		// Given
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			models: [{ id: "claude-sonnet" }, { id: "gpt-5.5" }],
			extensionFactories: [gptApplyPatchExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

		// When
		await harness.session.setModel(modelWithApi(harness, "gpt-5.5", "openai-responses"));

		// Then
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "apply_patch"]);
	});

	it("s2 restores edit tools when selecting an anthropic model from a Responses GPT", async () => {
		// Given
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }, { id: "claude-sonnet" }],
			extensionFactories: [gptApplyPatchExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "apply_patch"]);

		// When
		await harness.session.setModel(modelWithApi(harness, "claude-sonnet", "anthropic-messages"));

		// Then
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
	});

	it("s3 restores apply_patch after a GPT to anthropic to GPT round trip", async () => {
		// Given
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }, { id: "claude-sonnet" }],
			extensionFactories: [gptApplyPatchExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.setModel(modelWithApi(harness, "claude-sonnet", "anthropic-messages"));

		// When
		await harness.session.setModel(modelWithApi(harness, "gpt-5.5", "openai-responses"));

		// Then
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "apply_patch"]);
	});

	it("s4 exposes apply_patch as a JSON function tool for a completions GPT", async () => {
		// Given
		const harness = await createHarness({
			api: "openai-completions",
			provider: "openai",
			models: [{ id: "gpt-5.5" }],
			extensionFactories: [gptApplyPatchExtension],
		});
		harnesses.push(harness);

		// When
		await harness.session.bindExtensions({});

		// Then
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "apply_patch"]);
		// Chat Completions cannot carry freeform tools, so the registered variant
		// must be the plain JSON function definition.
		expect(harness.session.getToolDefinition("apply_patch")?.freeform).toBeUndefined();
	});
});
