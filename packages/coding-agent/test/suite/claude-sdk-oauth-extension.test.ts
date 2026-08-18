import { type Api, type Context, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { emptyCredential } from "../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	CLAUDE_SDK_OAUTH_PROVIDER_ID,
	registerClaudeSdkOauthExtension,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";

type Registration = { name: string; config: ProviderConfigInput };

function captureRegistration(readAmbientAuthStatus: () => Promise<boolean> = async () => false): {
	registration: Registration;
} {
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
	registerClaudeSdkOauthExtension(pi, { readAmbientAuthStatus });
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

function authenticatedStorage(): AuthStorage {
	return AuthStorage.inMemory({
		[CLAUDE_SDK_OAUTH_PROVIDER_ID]: {
			...emptyCredential(),
			accounts: [
				{
					name: "test",
					refresh: "test-refresh",
					access: "test-access",
					expires: Date.now() + 60_000,
					source: "login",
				},
			],
		},
	});
}

describe("claude-sdk-oauth builtin provider", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("registers the provider with OAuth, catalog models and a stream fn", () => {
		const { registration } = captureRegistration();
		const builtinIds = builtinExtensions.map((extension) => extension.id);
		expect(CLAUDE_SDK_OAUTH_PROVIDER_ID).toBe("claude-sdk-oauth");
		expect(builtinIds).toContain("claude-sdk-oauth");
		expect(builtinIds).not.toContain("claude-agent-sdk");
		expect(builtinIds).not.toContain("claude-oauth");
		expect(registration.name).toBe(CLAUDE_SDK_OAUTH_PROVIDER_ID);
		expect(registration.config.baseUrl).toBe(CLAUDE_SDK_OAUTH_PROVIDER_ID);
		expect(registration.config.apiKey).toBeUndefined();
		expect(registration.config.models?.length).toBeGreaterThan(0);
		expect(typeof registration.config.streamSimple).toBe("function");
	});

	it("keeps claude-sdk-oauth unavailable without a stored login", async () => {
		const { registration } = captureRegistration();
		const runtime = await createRuntimeWithProvider(registration.config);
		expect(runtime.hasConfiguredAuth(CLAUDE_SDK_OAUTH_PROVIDER_ID)).toBe(false);
		expect(await runtime.getAvailable(CLAUDE_SDK_OAUTH_PROVIDER_ID)).toEqual([]);
	});

	it("keeps claude-sdk-oauth unavailable with a persisted empty credential", async () => {
		const { registration } = captureRegistration();
		const storage = AuthStorage.inMemory({ [CLAUDE_SDK_OAUTH_PROVIDER_ID]: emptyCredential() });
		const runtime = await createRuntimeWithProvider(registration.config, storage);
		expect(runtime.hasConfiguredAuth(CLAUDE_SDK_OAUTH_PROVIDER_ID)).toBe(false);
		expect(await runtime.getAvailable(CLAUDE_SDK_OAUTH_PROVIDER_ID)).toEqual([]);
	});

	it("keeps claude-sdk-oauth available with a stored login", async () => {
		const { registration } = captureRegistration();
		const runtime = await createRuntimeWithProvider(registration.config, authenticatedStorage());
		expect(runtime.hasConfiguredAuth(CLAUDE_SDK_OAUTH_PROVIDER_ID)).toBe(true);
		expect(runtime.isUsingOAuth(CLAUDE_SDK_OAUTH_PROVIDER_ID)).toBe(true);
		expect(await runtime.getAvailable(CLAUDE_SDK_OAUTH_PROVIDER_ID)).not.toEqual([]);
	});

	it("keeps claude-sdk-oauth available with an environment token", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-token");
		const { registration } = captureRegistration();
		const runtime = await createRuntimeWithProvider(registration.config);
		expect(runtime.hasConfiguredAuth(CLAUDE_SDK_OAUTH_PROVIDER_ID)).toBe(true);
		expect(await runtime.getAvailable(CLAUDE_SDK_OAUTH_PROVIDER_ID)).not.toEqual([]);
	});

	it("keeps claude-sdk-oauth available with an authenticated ambient CLI", async () => {
		const { registration } = captureRegistration(async () => true);
		const runtime = await createRuntimeWithProvider(registration.config);
		expect(runtime.hasConfiguredAuth(CLAUDE_SDK_OAUTH_PROVIDER_ID)).toBe(true);
		expect(await runtime.getAvailable(CLAUDE_SDK_OAUTH_PROVIDER_ID)).not.toEqual([]);
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

	it("preflight reaches streamSimple with a stored login", async () => {
		const { registration } = captureRegistration();
		let called = false;
		const config: ProviderConfigInput = {
			...registration.config,
			streamSimple: (model: Model<Api>, context: Context) => {
				called = true;
				return fakeStreamSimple()(model, context);
			},
		};
		const runtime = await createRuntimeWithProvider(config, authenticatedStorage());
		const model = (await runtime.getAvailable(CLAUDE_SDK_OAUTH_PROVIDER_ID))[0];
		expect(model).toBeDefined();
		const stream = runtime.streamSimple(model as Model<Api>, { messages: [], tools: [] } as unknown as Context);
		for await (const event of stream) void event;
		expect(called).toBe(true);
	});
});
