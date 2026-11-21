/**
 * senpi#5674: the native-bypass decision belongs to the session that made it. Two sessions share one host
 * process (an rpc --multi-session host): session A runs a model that receives the native image_generation
 * server tool, session B runs a model that does not. A's arbitration must never make B's generate_image
 * defer to a native tool B does not have.
 */

import type { AssistantImages, ImageApi, ImageModel, Model } from "@earendil-works/pi-ai";
import { registerImagesApiProvider, unregisterImagesApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageGenAuthRegistry } from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import imageGenExtension from "../../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry } from "../../../src/core/extensions/builtin/imagegen/state.ts";
import type { GenerateImageDetails } from "../../../src/core/extensions/builtin/imagegen/tool.ts";
import openaiImageGenExtension from "../../../src/core/extensions/builtin/openai-image-gen/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const STUB_SOURCE_ID = "senpi-5674-session-bypass-stub";

const BASE_MODEL = {
	name: "test model",
	reasoning: false,
	input: ["text"] as ("text" | "image" | "video")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

/** Official OpenAI Responses: this session's requests carry the native image_generation tool. */
const nativeModel: Model<"openai-responses"> = {
	...BASE_MODEL,
	id: "gpt-5.5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
};

/** A non-OpenAI chat model: no native image tool, so generate_image is the only image path. */
const clientModel: Model<"anthropic-messages"> = {
	...BASE_MODEL,
	id: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
};

const gatewayRegistry: ImageGenAuthRegistry = {
	authStorage: { get: () => undefined },
	getAll: () => [
		{ provider: "images-gateway", id: "chat", baseUrl: "https://gateway.example/v1", api: "openai-completions" },
	],
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "gateway-key" }),
	getProviderAuth: async () => undefined,
};

const harnesses: Harness[] = [];
let imageCalls = 0;

async function startSession(model: Model<string>): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [imageGenExtension, openaiImageGenExtension] });
	harnesses.push(harness);
	harness.agent.state.model = model;
	await harness.session.bindExtensions({});
	return harness;
}

function generate(harness: Harness) {
	return harness.session.executeTool<GenerateImageDetails>(
		"generate_image",
		{ prompt: "a red circle" },
		{ activateInactiveTool: true },
	);
}

describe("senpi#5674 native bypass is per session", () => {
	beforeEach(() => {
		delete process.env.PI_OPENAI_IMAGE_GEN;
		imageCalls = 0;
		setImageGenRegistry(gatewayRegistry);
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

	it("#given a native session started after a client session in one process #when the client session calls generate_image #then it generates", async () => {
		const client = await startSession(clientModel);
		const native = await startSession(nativeModel);

		const clientResult = await generate(client);
		expect(clientResult.details.reason).toBeUndefined();
		expect(imageCalls).toBe(1);

		const nativeResult = await generate(native);
		expect(nativeResult.details.reason).toBe("provider_native_bypass");
		expect(imageCalls).toBe(1);
	});

	it("#given a client session started after a native session #when the native session calls generate_image #then it still defers", async () => {
		const native = await startSession(nativeModel);
		const client = await startSession(clientModel);

		const nativeResult = await generate(native);
		expect(nativeResult.details.reason).toBe("provider_native_bypass");

		const clientResult = await generate(client);
		expect(clientResult.details.reason).toBeUndefined();
		expect(imageCalls).toBe(1);
	});

	it("#given a native session that shuts down #when the other session calls generate_image #then it is unaffected", async () => {
		const client = await startSession(clientModel);
		const native = await startSession(nativeModel);
		native.cleanup();
		harnesses.splice(harnesses.indexOf(native), 1);

		const clientResult = await generate(client);
		expect(clientResult.details.reason).toBeUndefined();
		expect(imageCalls).toBe(1);
	});
});
