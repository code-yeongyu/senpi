import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import imageGenExtension from "../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry, setNativeBypass } from "../../src/core/extensions/builtin/imagegen/state.ts";
import type { GenerateImageDetails } from "../../src/core/extensions/builtin/imagegen/tool.ts";
import { supportsNativeOpenAiImageGeneration } from "../../src/core/extensions/builtin/openai-image-gen/gate.ts";
import openaiImageGenExtension from "../../src/core/extensions/builtin/openai-image-gen/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const subscription: Model<"openai-codex-responses"> = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	provider: "chatgpt-subscription",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};
const gateway: Model<"openai-responses"> = {
	...subscription,
	provider: "image-gateway",
	api: "openai-responses",
	baseUrl: "https://gateway.example/v1",
};
const payload = {
	tools: [
		{ type: "function", name: "generate_image", parameters: { type: "object" } },
		{ type: "function", name: "read", parameters: { type: "object" } },
	],
};
const harnesses: Harness[] = [];

afterEach(() => {
	setImageGenRegistry(undefined);
	setNativeBypass(false);
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

// Regression for https://github.com/code-yeongyu/senpi/issues/2432.
describe("ChatGPT subscription image generation", () => {
	it.each([
		["https://chatgpt.com/backend-api", true],
		["https://chatgpt.com/backend-api/codex/responses", true],
		["https://gateway.example/backend-api", false],
		["https://chatgpt.com.example/backend-api", false],
		["http://chatgpt.com/backend-api", false],
		["", false],
		["not a URL", false],
	])("routes subscription endpoint %s to native images: %s", (baseUrl, expected) => {
		// Given a subscription model with the candidate endpoint.
		const model = { ...subscription, baseUrl };
		// When the native capability gate runs.
		const supported = supportsNativeOpenAiImageGeneration(model);
		// Then only the official HTTPS endpoint is enabled.
		expect(supported).toBe(expected);
	});

	it("honors an explicit native image opt-out on a subscription model", () => {
		// Given an official subscription endpoint with native images disabled.
		const model = { ...subscription, compat: { supportsImageGeneration: false } };
		// When the native capability gate runs.
		const supported = supportsNativeOpenAiImageGeneration(model);
		// Then it remains disabled.
		expect(supported).toBe(false);
	});

	it("replaces the gateway tool for a subscription request and restores it on fallback", async () => {
		// Given both image builtins and a credentialed, unrelated gateway.
		setImageGenRegistry({
			authStorage: { get: () => undefined },
			getAll: () => [gateway],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			getProviderAuth: async () => undefined,
		});
		const harness = await createHarness({
			extensionFactories: [imageGenExtension, openaiImageGenExtension],
		});
		harnesses.push(harness);
		harness.agent.state.model = gateway;
		await harness.session.bindExtensions({});
		const runner = harness.getExtensionRunner();

		// When the effective request switches to the subscription model.
		const nativePayload = await runner.emitBeforeProviderRequest(payload, undefined, {
			model: subscription,
			headers: {},
		});
		// Then the native tool replaces the gateway tool, and direct gateway calls are blocked.
		expect(nativePayload).toEqual({
			tools: [payload.tools[1], { type: "image_generation", model: "gpt-image-2.5-sunburst" }],
		});
		const blocked = await harness.session.executeTool<GenerateImageDetails>(
			"generate_image",
			{ prompt: "an astronaut cat" },
			{ activateInactiveTool: true },
		);
		expect(blocked.details.reason).toBe("provider_native_bypass");

		// When fallback sends a request through the gateway again.
		const fallbackPayload = await runner.emitBeforeProviderRequest(payload, undefined, {
			model: gateway,
			headers: {},
		});
		// Then the native tool is removed and the client tool returns.
		expect(fallbackPayload).toEqual(payload);
	});
});
