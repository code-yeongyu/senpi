import { type Api, type Context, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import claudeSdkOauthExtension, {
	CLAUDE_SDK_OAUTH_PROVIDER_ID,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";

type Registration = { name: string; config: ProviderConfigInput };

function captureRegistration(): { registration: Registration } {
	let captured: Registration | undefined;
	const pi = {
		registerProvider: (name: string, config: ProviderConfigInput) => {
			captured = { name, config };
		},
		registerCommand: (..._args: unknown[]) => {},
		registerFlag: (..._args: unknown[]) => {},
		getFlag: () => undefined,
		on: (..._args: unknown[]) => {},
	} as unknown as ExtensionAPI;
	claudeSdkOauthExtension(pi);
	if (!captured) throw new Error("extension did not register a provider");
	return { registration: captured };
}

function fakeStreamSimple() {
	return (_model: Model<Api>, _context: Context) => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: undefined as never });
		stream.end();
		return stream;
	};
}

async function createRuntimeWithProvider(config: ProviderConfigInput, storage = AuthStorage.inMemory()) {
	const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, allowModelNetwork: false });
	await runtime.registerProvider(CLAUDE_SDK_OAUTH_PROVIDER_ID, config);
	return runtime;
}

describe("claude-sdk-oauth builtin provider", () => {
	it("registers the provider with sentinel auth, catalog models and a stream fn", () => {
		const { registration } = captureRegistration();
		const builtinIds = builtinExtensions.map((extension) => extension.id);
		expect(CLAUDE_SDK_OAUTH_PROVIDER_ID).toBe("claude-sdk-oauth");
		expect(builtinIds).toContain("claude-sdk-oauth");
		expect(builtinIds).not.toContain("claude-agent-sdk");
		expect(builtinIds).not.toContain("claude-oauth");
		expect(registration.name).toBe(CLAUDE_SDK_OAUTH_PROVIDER_ID);
		expect(registration.config.baseUrl).toBe(CLAUDE_SDK_OAUTH_PROVIDER_ID);
		expect(registration.config.models?.length).toBeGreaterThan(0);
		expect(typeof registration.config.streamSimple).toBe("function");
	});

	it("lists claude-sdk-oauth models in the runtime registry", async () => {
		const { registration } = captureRegistration();
		const runtime = await createRuntimeWithProvider(registration.config);
		const ids = (await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`);
		expect(ids.some((id) => id.startsWith(`${CLAUDE_SDK_OAUTH_PROVIDER_ID}/`))).toBe(true);
	});

	it("includes Claude Fable 5.1 in the registered model catalog", () => {
		const { registration } = captureRegistration();
		const ids = registration.config.models?.map((model) => model.id);
		expect(ids).toContain("claude-fable-5-1");
	});

	it("login selector lists the provider as oauth after registration", async () => {
		const { registration } = captureRegistration();
		const storage = AuthStorage.inMemory();
		await createRuntimeWithProvider(registration.config, storage);
		expect(storage.getOAuthProviders()).toContainEqual({
			id: CLAUDE_SDK_OAUTH_PROVIDER_ID,
			name: "Claude SDK OAuth (Claude Pro/Max)",
		});
	});

	it("preflight reaches streamSimple with zero stored credentials", async () => {
		const { registration } = captureRegistration();
		let called = false;
		const config: ProviderConfigInput = {
			...registration.config,
			streamSimple: (model: Model<Api>, context: Context) => {
				called = true;
				return fakeStreamSimple()(model, context);
			},
		};
		const runtime = await createRuntimeWithProvider(config);
		const model = (await runtime.getAvailable(CLAUDE_SDK_OAUTH_PROVIDER_ID))[0];
		expect(model).toBeDefined();
		const stream = runtime.streamSimple(model as Model<Api>, { messages: [], tools: [] } as unknown as Context);
		for await (const event of stream) void event;
		expect(called).toBe(true);
	});
});
