/**
 * senpi#5674: a logged-in built-in provider whose API has no OpenAI Images endpoint (xAI) must never be
 * scanned as an image gateway. Its built-in image catalog is the capability data: only a provider whose
 * catalog lists an `openai-images` model is scanned. A provider the user declared in models.json has no
 * catalog entry and keeps the 404/405 fall-through probe; an explicit PI_IMAGE_GEN_PROVIDER pin is honoured.
 */

import type { AssistantImages, ImageApi, ImageModel, Model } from "@earendil-works/pi-ai";
import { registerImagesApiProvider, unregisterImagesApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ImageGenAuthModel,
	type ImageGenAuthRegistry,
	type ImageGenRegistryAuthResult,
	imageGenCandidates,
} from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import imageGenExtension from "../../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry } from "../../../src/core/extensions/builtin/imagegen/state.ts";
import type { GenerateImageDetails } from "../../../src/core/extensions/builtin/imagegen/tool.ts";
import { createHarness, type Harness } from "../harness.ts";

const STUB_SOURCE_ID = "senpi-5674-gateway-capability-stub";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";

const xai: ImageGenAuthModel = {
	provider: "xai",
	id: "grok-test",
	api: "openai-completions",
	baseUrl: "https://api.x.ai/v1",
};
const groq: ImageGenAuthModel = {
	provider: "groq",
	id: "llama-test",
	api: "openai-completions",
	baseUrl: "https://api.groq.com/openai/v1",
};
const userGateway: ImageGenAuthModel = {
	provider: "my-images-gateway",
	id: "chat",
	api: "openai-completions",
	baseUrl: "https://gateway.example/v1",
};

function registry(models: ImageGenAuthModel[]): ImageGenAuthRegistry {
	const auth: Record<string, ImageGenRegistryAuthResult> = Object.fromEntries(
		models.map((model) => [model.provider, { ok: true, apiKey: `${model.provider}-key` }]),
	);
	return {
		authStorage: { get: () => undefined },
		getAll: () => models,
		getApiKeyAndHeaders: async (model) => auth[model.provider] ?? { ok: false, error: "no auth" },
		getProviderAuth: async () => undefined,
	};
}

async function candidateIds(models: ImageGenAuthModel[], env: Record<string, string> = {}): Promise<string[]> {
	const ids: string[] = [];
	for await (const candidate of imageGenCandidates({ modelRegistry: registry(models), env })) {
		ids.push(candidate.providerId ?? candidate.kind);
	}
	return ids;
}

describe("senpi#5674 scanned image gateways come from capability data", () => {
	it("#given only logged-in built-in chat providers without an images API #when scanning #then none is a candidate", async () => {
		expect(await candidateIds([xai, groq])).toEqual([]);
	});

	it("#given xai beside a user-declared gateway #when scanning #then only the user gateway is scanned", async () => {
		expect(await candidateIds([xai, userGateway])).toEqual(["my-images-gateway"]);
	});

	it("#given PI_IMAGE_GEN_PROVIDER names xai #when resolving #then the explicit pin is honoured", async () => {
		expect(await candidateIds([xai, userGateway], { PI_IMAGE_GEN_PROVIDER: "xai" })).toEqual(["xai"]);
	});
});

describe("senpi#5674 generate_image names the providers it could not use", () => {
	const harnesses: Harness[] = [];
	let imageCalls = 0;

	beforeEach(() => {
		imageCalls = 0;
		registerImagesApiProvider(
			{
				api: "openai-images" as const,
				async generateImages(model: ImageModel<ImageApi>): Promise<AssistantImages> {
					imageCalls += 1;
					return {
						api: "openai-images",
						provider: model.provider,
						model: model.id,
						output: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
						stopReason: "stop",
						timestamp: Date.now(),
					};
				},
			},
			STUB_SOURCE_ID,
		);
	});

	afterEach(() => {
		setImageGenRegistry(undefined);
		unregisterImagesApiProviders(STUB_SOURCE_ID);
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given only a logged-in xai #when generate_image runs #then it reports missing_config naming xai and sends nothing", async () => {
		setImageGenRegistry(registry([xai]));
		const harness = await createHarness({ extensionFactories: [imageGenExtension] });
		harnesses.push(harness);
		harness.agent.state.model = {
			id: "claude-test",
			name: "claude test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		} satisfies Model<"anthropic-messages">;
		await harness.session.bindExtensions({});

		const result = await harness.session.executeTool<GenerateImageDetails>(
			"generate_image",
			{ prompt: "a red circle" },
			{ activateInactiveTool: true },
		);

		expect(result.details.reason).toBe("missing_config");
		expect(result.details.unsupportedProviders).toEqual(["xai"]);
		expect(result.details.error).toContain("xai");
		expect(imageCalls).toBe(0);
	});
});
