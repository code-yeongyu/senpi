import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { imageGenAvailability, resolveImageGenAuth } from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import imageGenExtension from "../../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry, setNativeBypass } from "../../../src/core/extensions/builtin/imagegen/state.ts";
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
	])("names the source resolution would use: $name", async ({ providers, stored, env }) => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-5707-parity-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }));
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		if (stored !== undefined) await authStorage.modify("openai", async () => ({ type: "api_key", key: stored }));
		const registry = ModelRegistry.create(authStorage, join(dir, "models.json"));

		const resolved = await resolveImageGenAuth({ modelRegistry: registry, env });
		const available = await imageGenAvailability({ modelRegistry: registry, env });

		expect(available.kind === "none").toBe(resolved.kind === "none");
		if (available.kind !== "none" && resolved.kind !== "none") {
			expect({ providerId: available.providerId, provenance: available.provenance }).toEqual({
				providerId: resolved.providerId,
				provenance: resolved.provenance,
			});
		}
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
