import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	type ImageGenAuthModel,
	type ImageGenRegistryAuthResult,
	imageGenCandidates,
	resolveImageGenAuth,
} from "../../src/core/extensions/builtin/imagegen/auth.ts";
import {
	buildNativeEntries,
	type NativeModelInfo,
} from "../../src/core/extensions/builtin/websearch/websearch/native.ts";
import { type CredentialResolver, credentialResolverFromRegistry } from "../../src/core/runtime/credential-resolver.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

interface Fixture {
	readonly models: ImageGenAuthModel[];
	readonly storedOpenAi?: unknown;
	readonly modelAuth: Record<string, ImageGenRegistryAuthResult>;
	readonly providerAuth: Record<string, { auth: { apiKey?: string } } | undefined>;
}

function gateway(provider: string, api = "openai-completions"): ImageGenAuthModel {
	return { provider, id: `${provider}-chat`, api, baseUrl: `https://${provider}.example/v1` };
}

function fakeRegistry(fixture: Fixture) {
	return {
		authStorage: { get: (provider: string) => (provider === "openai" ? fixture.storedOpenAi : undefined) },
		getAll: () => fixture.models,
		getAvailable: () => fixture.models,
		getApiKeyAndHeaders: async (model: { provider: string }) =>
			fixture.modelAuth[model.provider] ?? { ok: false as const, error: "missing fake auth" },
		getProviderAuth: async (provider: string) => fixture.providerAuth[provider],
	};
}

const fixtures: Record<string, Fixture> = {
	"a stored openai key": {
		models: [gateway("openai", "openai-responses")],
		storedOpenAi: { type: "api_key", key: "sk-stored" },
		modelAuth: { openai: { ok: true, apiKey: "sk-stored" } },
		providerAuth: { openai: { auth: { apiKey: "sk-stored" } } },
	},
	"scanned gateways": {
		models: [gateway("zeta-gateway"), gateway("openai-proxy")],
		modelAuth: {
			"zeta-gateway": { ok: true, apiKey: "zeta-key" },
			"openai-proxy": { ok: true, apiKey: "proxy-key", headers: { "x-route": "a" } },
		},
		providerAuth: {},
	},
	"nothing configured": { models: [], modelAuth: {}, providerAuth: {} },
};

async function candidates(registry: Parameters<typeof imageGenCandidates>[0]["modelRegistry"], env = {}) {
	const out = [];
	for await (const candidate of imageGenCandidates({ modelRegistry: registry, env })) out.push(candidate);
	return out;
}

describe("credential lookup through the runtime's credential resolver (RT4)", () => {
	it.each(Object.keys(fixtures))("image generation resolves %s exactly as the registry does", async (name) => {
		// Given the same credentials seen through the session registry and through the resolver.
		const registry = fakeRegistry(fixtures[name]);
		const resolver: CredentialResolver = credentialResolverFromRegistry(registry);
		// Then every candidate and the first resolution are identical.
		expect(await candidates(resolver)).toEqual(await candidates(registry));
		expect(await resolveImageGenAuth({ modelRegistry: resolver, env: {} })).toEqual(
			await resolveImageGenAuth({ modelRegistry: registry, env: {} }),
		);
	});

	it("image generation keeps the environment key fallback", async () => {
		const resolver = credentialResolverFromRegistry(fakeRegistry(fixtures["nothing configured"]));
		const env = { OPENAI_API_KEY: "sk-env-real" };
		expect(await resolveImageGenAuth({ modelRegistry: resolver, env })).toEqual(
			await resolveImageGenAuth({ modelRegistry: fakeRegistry(fixtures["nothing configured"]), env }),
		);
	});

	it("native web search builds the same entries from the resolver", async () => {
		const active: NativeModelInfo = {
			provider: "openai",
			id: "gpt-5",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
		};
		const registry = fakeRegistry({
			models: [active],
			modelAuth: { openai: { ok: true, apiKey: "sk-search", baseUrl: "https://account.example/v1" } },
			providerAuth: {},
		});
		const resolver = credentialResolverFromRegistry(registry);
		expect(await buildNativeEntries(active, resolver)).toEqual(await buildNativeEntries(active, registry));
	});

	it("wraps a real session registry without changing its answers", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const resolver = credentialResolverFromRegistry(registry);
		expect(resolver.getAll()).toEqual(registry.getAll());
		expect(await resolver.getProviderAuth("openai")).toEqual(await registry.getProviderAuth("openai"));
		expect(await resolveImageGenAuth({ modelRegistry: resolver, env: {} })).toEqual(
			await resolveImageGenAuth({ modelRegistry: registry, env: {} }),
		);
	});
});
