import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantImages, ImageApi, ImageModel, Model } from "@earendil-works/pi-ai";
import { registerImagesApiProvider, unregisterImagesApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	type ImageGenAuthModel,
	type ImageGenAuthRegistry,
	imageGenAvailability,
	resolveImageGenAuth,
} from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import imageGenExtension from "../../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry, setNativeBypass } from "../../../src/core/extensions/builtin/imagegen/state.ts";
import { type GenerateImageDetails, generateImageTool } from "../../../src/core/extensions/builtin/imagegen/tool.ts";
import openaiImageGenExtension from "../../../src/core/extensions/builtin/openai-image-gen/index.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { clearConfigValueCache } from "../../../src/core/resolve-config-value.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createTestExtensionsResult } from "../../utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	setImageGenRegistry(undefined);
	setNativeBypass(false);
	clearConfigValueCache();
	vi.unstubAllEnvs();
	while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
});

/**
 * A gateway whose key comes from a credential helper that fails, as a `!jq` key reading a file the
 * host does not have does. Every run of the helper appends one byte to `marker`.
 */
function fixture(): { cwd: string; marker: string; registry: ModelRegistry; gateway: Model<Api> } {
	const dir = mkdtempSync(join(tmpdir(), "senpi-5707-"));
	tempDirs.push(dir);
	const marker = join(dir, "helper-runs");
	const modelsJsonPath = join(dir, "models.json");
	writeFileSync(
		modelsJsonPath,
		JSON.stringify({
			providers: {
				"helper-gateway": {
					api: "openai-completions",
					baseUrl: "https://helper-gateway.example/v1",
					apiKey: `!printf x >> '${marker}'; exit 1`,
					models: [{ id: "helper-chat" }],
				},
			},
		}),
	);
	const registry = ModelRegistry.create(AuthStorage.create(join(dir, "auth.json")), modelsJsonPath);
	expect(registry.getError()).toBeUndefined();
	const gateway = registry.getAll().find((model) => model.provider === "helper-gateway");
	if (gateway === undefined) throw new Error("helper-gateway model missing from the registry");
	return { cwd: dir, marker, registry, gateway };
}

function helperRuns(marker: string): number {
	return existsSync(marker) ? readFileSync(marker, "utf8").length : 0;
}

async function runnerFor(cwd: string, registry: ModelRegistry): Promise<ExtensionRunner> {
	const extensionsResult = await createTestExtensionsResult(
		[
			{ factory: imageGenExtension, path: "<builtin:imagegen>" },
			{ factory: openaiImageGenExtension, path: "<builtin:openai-image-gen>" },
		],
		cwd,
	);
	return new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		cwd,
		SessionManager.inMemory(),
		registry,
	);
}

describe("senpi#5707: image-generation availability is decided without running credential helpers", () => {
	it("contributes the skill for a helper-keyed gateway without running its helper", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		const { cwd, marker, registry } = fixture();
		const runner = await runnerFor(cwd, registry);

		const resources = await runner.emitResourcesDiscover(cwd, "startup");

		expect(helperRuns(marker)).toBe(0);
		expect(resources.skillPaths).toHaveLength(1);
	});

	it("keeps the client tool on a request without running the helper", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		const { cwd, marker, registry, gateway } = fixture();
		const runner = await runnerFor(cwd, registry);
		const payload = { model: gateway.id, tools: [{ name: "generate_image" }] };

		const sent = await runner.emitBeforeProviderRequest(payload, undefined, { model: gateway, headers: {} });

		expect(helperRuns(marker)).toBe(0);
		expect(sent).toEqual(payload);
	});

	const gateway = (name: string) => ({
		api: "openai-completions",
		baseUrl: `https://${name}.example/v1`,
		apiKey: `${name}-key`,
		models: [{ id: `${name}-chat` }],
	});
	it.each([
		{ name: "nothing configured", providers: {}, env: {} },
		{ name: "a stored openai key", providers: { aaa: gateway("aaa") }, stored: "sk-stored-test", env: {} },
		{
			name: "a placeholder stored key",
			providers: { aaa: gateway("aaa") },
			stored: "SK-SENTINEL-DO-NOT-LOG-1",
			env: {},
		},
		{
			name: "an openai override",
			providers: { openai: { baseUrl: "https://proxy.example/v1", apiKey: "proxy-key" }, aaa: gateway("aaa") },
			env: {},
		},
		{ name: "an override without a key", providers: { openai: { baseUrl: "https://proxy.example/v1" } }, env: {} },
		{
			name: "a pinned gateway",
			providers: { openai: { baseUrl: "https://proxy.example/v1", apiKey: "proxy-key" }, zzz: gateway("zzz") },
			env: { PI_IMAGE_GEN_PROVIDER: "zzz" },
		},
		{ name: "scanned gateways", providers: { zzz: gateway("zzz"), "my-openai": gateway("my-openai") }, env: {} },
		{ name: "only OPENAI_API_KEY", providers: {}, env: { OPENAI_API_KEY: "sk-env-test" } },
		{
			name: "a gateway keyed only by a header",
			providers: {
				hdr: {
					api: "openai-completions",
					baseUrl: "https://hdr.example/v1",
					headers: { Authorization: "Bearer hdr-token" },
					models: [{ id: "hdr-chat" }],
				},
			},
			env: {},
		},
		{
			name: "a built-in gateway with its env key plus a credential header",
			providers: { openrouter: { headers: { "X-Api-Key": "hdr-value" } } },
			processEnv: { OPENROUTER_API_KEY: "sk-or-test" },
			env: {},
		},
		{
			name: "an openai override keyed by a header plus OPENAI_API_KEY",
			providers: { openai: { baseUrl: "https://proxy.example/v1", headers: { "X-Api-Key": "hdr-value" } } },
			processEnv: { OPENAI_API_KEY: "sk-env-test" },
			env: { OPENAI_API_KEY: "sk-env-test" },
		},
		{
			name: "a runtime key over a stored placeholder",
			providers: {},
			stored: "SK-SENTINEL-DO-NOT-LOG-2",
			runtime: "sk-runtime-test",
			env: {},
		},
	])("names the source resolution would use: $name", async ({ providers, stored, runtime, env, processEnv }) => {
		for (const [name, value] of Object.entries(processEnv ?? {})) vi.stubEnv(name, value);
		const dir = mkdtempSync(join(tmpdir(), "senpi-5707-parity-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }));
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		if (stored !== undefined) await authStorage.modify("openai", async () => ({ type: "api_key", key: stored }));
		const registry = ModelRegistry.create(authStorage, join(dir, "models.json"));
		if (runtime !== undefined) await registry.modelRuntime.setRuntimeApiKey("openai", runtime);
		// A session open builds its services with this offline availability pass first.
		await registry.refresh({ allowNetwork: false });

		const resolved = await resolveImageGenAuth({ modelRegistry: registry, env });
		const available = await imageGenAvailability({ modelRegistry: registry, env });

		expect(available.kind === "none").toBe(resolved.kind === "none");
		if (available.kind !== "none" && resolved.kind !== "none") {
			expect({ kind: available.kind, providerId: available.providerId, provenance: available.provenance }).toEqual({
				kind: resolved.kind,
				providerId: resolved.providerId,
				provenance: resolved.provenance,
			});
		}
	});

	it.each([
		{
			name: "a models.json openai override",
			providers: (helper: string) => ({ openai: { baseUrl: "https://proxy.example/v1", apiKey: helper } }),
		},
		{ name: "a stored openai key", providers: () => ({}), stored: true },
	])("keeps image generation when the ONLY key is a helper: $name", async ({ providers, stored }) => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		const dir = mkdtempSync(join(tmpdir(), "senpi-5707-helper-only-"));
		tempDirs.push(dir);
		const marker = join(dir, "helper-runs");
		const helper = `!printf x >> '${marker}'; exit 1`;
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: providers(helper) }));
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		if (stored) await authStorage.modify("openai", async () => ({ type: "api_key", key: helper }));
		const registry = ModelRegistry.create(authStorage, join(dir, "models.json"));
		const runner = await runnerFor(dir, registry);

		const resources = await runner.emitResourcesDiscover(dir, "startup");

		expect(resources.skillPaths).toHaveLength(1);
		expect(helperRuns(marker)).toBe(0);
	});

	it("runs the helper at use time and reports its failure as credential_unavailable", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		const { cwd, marker, registry } = fixture();
		setImageGenRegistry(registry);
		const ctx = { cwd, modelRegistry: registry } as unknown as Parameters<typeof generateImageTool.execute>[4];

		const result = await generateImageTool.execute("call-1", { prompt: "a red fox" }, undefined, undefined, ctx);

		const details = result.details as GenerateImageDetails;
		expect(details.reason).toBe("credential_unavailable");
		expect(JSON.stringify(result.content)).toContain("helper-gateway");
		expect(helperRuns(marker)).toBeGreaterThan(0);
	});

	it("reports nothing configured when no source names a key", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		const dir = mkdtempSync(join(tmpdir(), "senpi-5707-empty-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }));
		const registry = ModelRegistry.create(AuthStorage.create(join(dir, "auth.json")), join(dir, "models.json"));
		const runner = await runnerFor(dir, registry);

		const resources = await runner.emitResourcesDiscover(dir, "startup");

		expect(resources.skillPaths).toEqual([]);
	});
});

describe("senpi#5707 with senpi#5674: availability scans only gateways that serve OpenAI Images", () => {
	const xai: ImageGenAuthModel = {
		provider: "xai",
		id: "grok-test",
		api: "openai-completions",
		baseUrl: "https://api.x.ai/v1",
	};
	const userGateway: ImageGenAuthModel = {
		provider: "my-images-gateway",
		id: "chat",
		api: "openai-completions",
		baseUrl: "https://gateway.example/v1",
	};

	function keyedRegistry(models: ImageGenAuthModel[]): ImageGenAuthRegistry {
		return {
			authStorage: { get: () => undefined },
			getAll: () => models,
			getApiKeyAndHeaders: async (model) => ({ ok: true, apiKey: `${model.provider}-key` }),
			getProviderAuth: async () => undefined,
			getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
			providerAuthIsHeaderOnly: () => false,
		};
	}

	it.each([
		{ name: "only a logged-in xai", models: [xai], env: {}, expected: undefined },
		{
			name: "xai beside a user-declared gateway",
			models: [xai, userGateway],
			env: {},
			expected: "my-images-gateway",
		},
		{
			name: "xai pinned with PI_IMAGE_GEN_PROVIDER",
			models: [xai, userGateway],
			env: { PI_IMAGE_GEN_PROVIDER: "xai" },
			expected: "xai",
		},
	])("agrees with resolution: $name", async ({ models, env, expected }) => {
		const registry = keyedRegistry(models);

		const available = await imageGenAvailability({ modelRegistry: registry, env });
		const resolved = await resolveImageGenAuth({ modelRegistry: registry, env });

		expect(available.kind === "none" ? undefined : available.providerId).toBe(expected);
		expect(resolved.kind === "none" ? undefined : resolved.providerId).toBe(expected);
	});
});

describe("senpi#5707 with senpi#5674: generate_image orders credential_unavailable before missing_config", () => {
	const STUB_SOURCE_ID = "senpi-5707-tool-order-stub";
	const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
	const xai: ImageGenAuthModel = {
		provider: "xai",
		id: "grok-test",
		api: "openai-completions",
		baseUrl: "https://api.x.ai/v1",
	};
	const userGateway: ImageGenAuthModel = {
		provider: "my-images-gateway",
		id: "chat",
		api: "openai-completions",
		baseUrl: "https://gateway.example/v1",
	};
	let imageCalls = 0;
	let cwd = "";

	// The real ModelRegistry shape: provider auth status is reported statically, so availability never
	// falls back to resolving keys. `unresolved` providers are configured but their key does not resolve.
	function staticRegistry(models: ImageGenAuthModel[], unresolved: string[] = []): ImageGenAuthRegistry {
		return {
			authStorage: { get: () => undefined },
			getAll: () => models,
			getApiKeyAndHeaders: async (model) =>
				unresolved.includes(model.provider)
					? { ok: false, error: "key command failed" }
					: { ok: true, apiKey: `${model.provider}-key` },
			getProviderAuth: async () => undefined,
			getProviderAuthStatus: (provider) =>
				models.some((model) => model.provider === provider)
					? { configured: true, source: "models_json_command" }
					: { configured: false },
			providerAuthIsHeaderOnly: () => false,
		};
	}

	beforeEach(() => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		imageCalls = 0;
		cwd = mkdtempSync(join(tmpdir(), "senpi-5707-tool-order-"));
		tempDirs.push(cwd);
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
	});

	it.each([
		{
			name: "only a logged-in xai",
			models: [xai],
			unresolved: [],
			reason: "missing_config",
			unsupported: ["xai"],
			calls: 0,
		},
		{
			name: "xai beside a user gateway",
			models: [xai, userGateway],
			unresolved: [],
			reason: undefined,
			unsupported: undefined,
			calls: 1,
		},
		{
			name: "nothing configured",
			models: [],
			unresolved: [],
			reason: "missing_config",
			unsupported: undefined,
			calls: 0,
		},
		{
			name: "xai beside a configured gateway whose key does not resolve",
			models: [xai, userGateway],
			unresolved: ["my-images-gateway"],
			reason: "credential_unavailable",
			unsupported: undefined,
			calls: 0,
		},
	])("$name", async ({ models, unresolved, reason, unsupported, calls }) => {
		const registry = staticRegistry(models, unresolved);
		setImageGenRegistry(registry);
		const ctx = { cwd, modelRegistry: registry } as unknown as Parameters<typeof generateImageTool.execute>[4];

		const result = await generateImageTool.execute("call-1", { prompt: "a red fox" }, undefined, undefined, ctx);

		const details = result.details as GenerateImageDetails;
		expect(details.reason).toBe(reason);
		expect(details.unsupportedProviders).toEqual(unsupported);
		expect(imageCalls).toBe(calls);
		if (reason === "credential_unavailable") expect(JSON.stringify(result.content)).toContain("my-images-gateway");
	});
});
