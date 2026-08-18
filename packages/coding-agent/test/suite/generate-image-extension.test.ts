import type { AssistantImages, ImagesContext, ImagesModel, Model, ProviderImagesOptions } from "@earendil-works/pi-ai";
import { registerImagesApiProvider, unregisterImagesApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageGenAuthRegistry } from "../../src/core/extensions/builtin/imagegen/auth.ts";
import imageGenExtension from "../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry, setNativeBypass } from "../../src/core/extensions/builtin/imagegen/state.ts";
import type { GenerateImageDetails } from "../../src/core/extensions/builtin/imagegen/tool.ts";
import openaiImageGenExtension, {
	supportsNativeOpenAiImageGeneration,
} from "../../src/core/extensions/builtin/openai-image-gen/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const ENABLE_ENV = "PI_OPENAI_IMAGE_GEN";
const STUB_SOURCE_ID = "openai-image-gen-test-stub";
const GENERATE_IMAGE = "generate_image";
const NATIVE_TYPE = "image_generation";

const BASE_MODEL = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	reasoning: false,
	input: ["text"] as ("text" | "image" | "video")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

const officialOpenAi: Model<"openai-responses"> = {
	...BASE_MODEL,
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
};

const officialCompatDisabled: Model<"openai-responses"> = {
	...officialOpenAi,
	compat: { supportsImageGeneration: false },
};

const proxiedOpenAi: Model<"openai-responses"> = {
	...BASE_MODEL,
	api: "openai-responses",
	provider: "quotio-openai",
	baseUrl: "https://gateway.example/openai/v1",
};

const proxiedCompatEnabled: Model<"openai-responses"> = {
	...proxiedOpenAi,
	compat: { supportsImageGeneration: true },
};

const azureResponses: Model<"azure-openai-responses"> = {
	...BASE_MODEL,
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://contoso.openai.azure.com/openai/v1",
};

const officialCompletions: Model<"openai-completions"> = {
	...BASE_MODEL,
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
};

interface PayloadTool {
	type?: string;
	name?: string;
}

function readTools(payload: unknown): PayloadTool[] {
	if (typeof payload !== "object" || payload === null || !("tools" in payload)) {
		throw new Error("payload carries no tools array");
	}
	const tools = payload.tools;
	if (!Array.isArray(tools)) throw new Error("payload.tools is not an array");
	return tools.map((tool: unknown) => {
		if (typeof tool !== "object" || tool === null) return {};
		const type = "type" in tool && typeof tool.type === "string" ? tool.type : undefined;
		const name = "name" in tool && typeof tool.name === "string" ? tool.name : undefined;
		return { type, name };
	});
}

function functionToolNames(payload: unknown): string[] {
	return readTools(payload).flatMap((tool) => (tool.name === undefined ? [] : [tool.name]));
}

function nativeImageTools(payload: unknown): PayloadTool[] {
	return readTools(payload).filter((tool) => tool.type === NATIVE_TYPE);
}

function requestPayload(): Record<string, unknown> {
	return {
		model: "gpt-5.5",
		tools: [
			{ type: "function", name: GENERATE_IMAGE, parameters: { type: "object" } },
			{ type: "function", name: "read", parameters: { type: "object" } },
		],
	};
}

const credentialedRegistry: ImageGenAuthRegistry = {
	authStorage: { get: () => undefined },
	getAll: () => [
		{
			provider: "quotio-openai",
			id: "gpt-5",
			baseUrl: "https://gateway.example/openai/v1",
			api: "openai-completions",
		},
	],
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "gateway-secret" }),
	getProviderAuth: async () => undefined,
};

const emptyRegistry: ImageGenAuthRegistry = {
	authStorage: { get: () => undefined },
	getAll: () => [],
	getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }),
	getProviderAuth: async () => undefined,
};

interface StubController {
	calls: number;
}

function registerStubImagesProvider(): StubController {
	const controller = { calls: 0 };
	registerImagesApiProvider(
		{
			api: "openai-images" as const,
			async generateImages(
				model: ImagesModel<"openai-images">,
				_context: ImagesContext,
				_options?: ProviderImagesOptions,
			): Promise<AssistantImages> {
				controller.calls += 1;
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
	return controller;
}

const harnesses: Harness[] = [];

interface SessionOptions {
	credentials?: boolean;
	model?: Model<string>;
}

/**
 * Boots a session with both image-generation builtins loaded, mirroring the
 * builtin catalog order (imagegen first, then the native injector).
 */
async function startSession(options: SessionOptions = {}): Promise<Harness> {
	setImageGenRegistry(options.credentials === false ? emptyRegistry : credentialedRegistry);
	const harness = await createHarness({
		extensionFactories: [imageGenExtension, openaiImageGenExtension],
	});
	harnesses.push(harness);
	for (const provider of ["openai", "quotio-openai", "azure"]) {
		harness.modelRegistry.registerProvider(provider, {
			baseUrl: "https://api.openai.com/v1",
			apiKey: "test-key",
			api: "openai-responses",
			models: [{ ...BASE_MODEL, api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
		});
	}
	if (options.model) harness.agent.state.model = options.model;
	await harness.session.bindExtensions({});
	return harness;
}

async function payloadFor(harness: Harness, payload: unknown = requestPayload()): Promise<unknown> {
	return harness.getExtensionRunner().emitBeforeProviderRequest(payload);
}

describe("openai-image-gen arbitration", () => {
	beforeEach(() => {
		delete process.env[ENABLE_ENV];
		setNativeBypass(false);
		setImageGenRegistry(undefined);
	});

	afterEach(() => {
		delete process.env[ENABLE_ENV];
		setNativeBypass(false);
		setImageGenRegistry(undefined);
		unregisterImagesApiProviders(STUB_SOURCE_ID);
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given credentials on a proxied responses model #when a request is sent #then only the client function tool is exposed", async () => {
		const harness = await startSession({ model: proxiedOpenAi });

		const payload = await payloadFor(harness);

		expect(functionToolNames(payload)).toContain(GENERATE_IMAGE);
		expect(nativeImageTools(payload)).toHaveLength(0);
	});

	it("#given the official openai responses endpoint #when a request is sent #then exactly one server tool replaces the function tool", async () => {
		const harness = await startSession({ model: officialOpenAi });

		const payload = await payloadFor(harness);

		expect(nativeImageTools(payload)).toEqual([{ type: NATIVE_TYPE, name: undefined }]);
		expect(functionToolNames(payload)).not.toContain(GENERATE_IMAGE);
		expect(functionToolNames(payload)).toContain("read");
		const bypassed = await harness.session.executeTool<GenerateImageDetails>(GENERATE_IMAGE, { prompt: "a fox" });
		expect(bypassed.details.reason).toBe("provider_native_bypass");
	});

	it("#given no credentials on a proxied responses model #when a request is sent #then neither image tool is exposed", async () => {
		const harness = await startSession({ model: proxiedOpenAi, credentials: false });

		const payload = await payloadFor(harness);

		expect(functionToolNames(payload)).not.toContain(GENERATE_IMAGE);
		expect(nativeImageTools(payload)).toHaveLength(0);
	});

	it("#given a client session #when the model switches to the official endpoint #then the server tool takes over", async () => {
		const harness = await startSession({ model: proxiedOpenAi });
		expect(nativeImageTools(await payloadFor(harness))).toHaveLength(0);

		await harness.session.setModel(officialOpenAi);

		const payload = await payloadFor(harness);
		expect(nativeImageTools(payload)).toHaveLength(1);
		expect(functionToolNames(payload)).not.toContain(GENERATE_IMAGE);
	});

	it("#given a native session #when the model switches to a proxied endpoint #then the client tool takes over again", async () => {
		const harness = await startSession({ model: officialOpenAi });
		expect(nativeImageTools(await payloadFor(harness))).toHaveLength(1);

		await harness.session.setModel(proxiedOpenAi);

		const payload = await payloadFor(harness);
		expect(nativeImageTools(payload)).toHaveLength(0);
		expect(functionToolNames(payload)).toContain(GENERATE_IMAGE);
		const executed = await harness.session.executeTool<GenerateImageDetails>(GENERATE_IMAGE, { prompt: "a fox" });
		expect(executed.details.reason).not.toBe("provider_native_bypass");
	});

	it("#given a native session without credentials #when the model switches to a proxied endpoint #then both image tools disappear", async () => {
		const harness = await startSession({ model: officialOpenAi, credentials: false });
		expect(nativeImageTools(await payloadFor(harness))).toHaveLength(1);

		await harness.session.setModel(proxiedOpenAi);

		const payload = await payloadFor(harness);
		expect(nativeImageTools(payload)).toHaveLength(0);
		expect(functionToolNames(payload)).not.toContain(GENERATE_IMAGE);
	});

	it("#given an unavailable session #when the model switches to the official endpoint #then the server tool appears", async () => {
		const harness = await startSession({ model: proxiedOpenAi, credentials: false });
		expect(nativeImageTools(await payloadFor(harness))).toHaveLength(0);

		await harness.session.setModel(officialOpenAi);

		const payload = await payloadFor(harness);
		expect(nativeImageTools(payload)).toHaveLength(1);
		expect(functionToolNames(payload)).not.toContain(GENERATE_IMAGE);
	});

	it("#given a proxied responses endpoint without a compat flag #when the gate runs #then it defaults to the client tool", () => {
		expect(supportsNativeOpenAiImageGeneration(proxiedOpenAi)).toBe(false);
		expect(supportsNativeOpenAiImageGeneration(azureResponses)).toBe(false);
	});

	it("#given a proxied responses endpoint with compat opt-in #when a request is sent #then the server tool is injected", async () => {
		const harness = await startSession({ model: proxiedCompatEnabled });

		const payload = await payloadFor(harness);

		expect(supportsNativeOpenAiImageGeneration(proxiedCompatEnabled)).toBe(true);
		expect(nativeImageTools(payload)).toHaveLength(1);
		expect(functionToolNames(payload)).not.toContain(GENERATE_IMAGE);
	});

	it("#given the official endpoint with compat disabled #when a request is sent #then the client tool stays", async () => {
		const harness = await startSession({ model: officialCompatDisabled });

		const payload = await payloadFor(harness);

		expect(supportsNativeOpenAiImageGeneration(officialCompatDisabled)).toBe(false);
		expect(nativeImageTools(payload)).toHaveLength(0);
		expect(functionToolNames(payload)).toContain(GENERATE_IMAGE);
	});

	it("#given a non-responses api #when a payload already carries a native image tool #then it is stripped defensively", async () => {
		const harness = await startSession({ model: officialCompletions });

		const payload = await payloadFor(harness, {
			model: "gpt-5.5",
			tools: [{ type: NATIVE_TYPE }, { type: "function", name: GENERATE_IMAGE, parameters: { type: "object" } }],
		});

		expect(nativeImageTools(payload)).toHaveLength(0);
		expect(functionToolNames(payload)).toContain(GENERATE_IMAGE);
	});

	it("#given credentials appear after session start #when the tool executes #then it resolves them instead of a startup snapshot", async () => {
		const stub = registerStubImagesProvider();
		const harness = await startSession({ model: proxiedOpenAi, credentials: false });
		const blocked = await harness.session.executeTool<GenerateImageDetails>(GENERATE_IMAGE, { prompt: "a fox" });
		expect(blocked.details.reason).toBe("missing_config");

		setImageGenRegistry(credentialedRegistry);

		const executed = await harness.session.executeTool<GenerateImageDetails>(GENERATE_IMAGE, { prompt: "a fox" });
		expect(executed.details.reason).toBeUndefined();
		expect(executed.details.paths).toHaveLength(1);
		expect(stub.calls).toBe(1);
	});

	it("#given a cached client model #when the hook observes a different request model #then it refreshes before mutating", async () => {
		const harness = await startSession({ model: proxiedOpenAi });

		const payload = await harness
			.getExtensionRunner()
			.emitBeforeProviderRequest(requestPayload(), undefined, { model: officialOpenAi, headers: {} });

		expect(nativeImageTools(payload)).toHaveLength(1);
		expect(functionToolNames(payload)).not.toContain(GENERATE_IMAGE);
	});

	it("#given the enable env is off #when the official endpoint sends a request #then the client tool stays active", async () => {
		process.env[ENABLE_ENV] = "0";
		const harness = await startSession({ model: officialOpenAi });

		const payload = await payloadFor(harness);

		expect(nativeImageTools(payload)).toHaveLength(0);
		expect(functionToolNames(payload)).toContain(GENERATE_IMAGE);
	});

	it("#given nothing to change #when the hook runs #then the original payload reference is returned", async () => {
		const harness = await startSession({ model: proxiedOpenAi });
		const payload = { model: "gpt-5.5", tools: [{ type: "function", name: "read", parameters: {} }] };

		const result = await payloadFor(harness, payload);

		expect(result).toBe(payload);
	});
});
