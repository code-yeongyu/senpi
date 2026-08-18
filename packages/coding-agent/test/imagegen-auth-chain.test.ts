import { describe, expect, it } from "vitest";
import {
	type ImageGenAuthModel,
	type ImageGenAuthRegistry,
	type ImageGenRegistryAuthResult,
	resolveImageGenAuth,
} from "../src/core/extensions/builtin/imagegen/auth.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";

interface FakeRegistryOptions {
	models?: ImageGenAuthModel[];
	storedOpenAi?: unknown;
	modelAuth?: Record<string, ImageGenRegistryAuthResult>;
	providerAuth?: Record<string, { auth: { apiKey?: string; headers?: Record<string, string | null> } } | undefined>;
}

function model(provider: string, overrides: Partial<ImageGenAuthModel> = {}): ImageGenAuthModel {
	return {
		provider,
		id: `${provider}-chat`,
		api: "openai-completions",
		baseUrl: `https://${provider}.example/v1`,
		...overrides,
	};
}

function fakeRegistry(options: FakeRegistryOptions = {}): ImageGenAuthRegistry<ImageGenAuthModel> {
	return {
		authStorage: {
			get(provider) {
				return provider === "openai" ? options.storedOpenAi : undefined;
			},
		},
		getAll() {
			return options.models ?? [];
		},
		async getApiKeyAndHeaders(candidate) {
			return options.modelAuth?.[candidate.provider] ?? { ok: false, error: "missing fake auth" };
		},
		async getProviderAuth(provider) {
			return options.providerAuth?.[provider];
		},
	};
}

async function resolve(options: FakeRegistryOptions = {}, env: Record<string, string | undefined> = {}) {
	return resolveImageGenAuth({ modelRegistry: fakeRegistry(options), env });
}

function resolveWithRealRegistrySurface(modelRegistry: ModelRegistry) {
	return resolveImageGenAuth({ modelRegistry, env: {} });
}
void resolveWithRealRegistrySurface;

describe("imagegen credential resolution", () => {
	it("prefers stored native OpenAI auth over a pinned gateway", async () => {
		const result = await resolve(
			{
				models: [model("pinned-openai")],
				storedOpenAi: { type: "api_key", key: "stored-secret" },
				providerAuth: { openai: { auth: { apiKey: "stored-secret" } } },
				modelAuth: { "pinned-openai": { ok: true, apiKey: "gateway-secret" } },
			},
			{ PI_IMAGE_GEN_PROVIDER: "pinned-openai" },
		);

		expect(result).toEqual({
			kind: "native-openai",
			apiKey: "stored-secret",
			baseUrl: "https://api.openai.com/v1",
			provenance: "store",
			providerId: "openai",
		});
	});

	it("prefers an explicit provider pin over gateway scanning", async () => {
		const result = await resolve(
			{
				models: [model("alpha-openai"), model("pinned-gateway")],
				modelAuth: {
					"alpha-openai": { ok: true, apiKey: "alpha-key" },
					"pinned-gateway": { ok: true, apiKey: "pinned-key" },
				},
			},
			{ PI_IMAGE_GEN_PROVIDER: "pinned-gateway" },
		);

		expect(result).toMatchObject({ kind: "gateway", providerId: "pinned-gateway", apiKey: "pinned-key" });
	});

	it("uses a valid gateway when native OpenAI auth is absent", async () => {
		const result = await resolve({
			models: [model("quotio-openai")],
			modelAuth: { "quotio-openai": { ok: true, apiKey: "gateway-key" } },
		});

		expect(result).toEqual({
			kind: "gateway",
			apiKey: "gateway-key",
			baseUrl: "https://quotio-openai.example/v1",
			provenance: "provider-config",
			providerId: "quotio-openai",
		});
	});

	it("skips a source missing baseUrl without mixing its key into another route", async () => {
		const result = await resolve(
			{
				models: [model("broken", { baseUrl: "" }), model("fallback")],
				modelAuth: {
					broken: { ok: true, apiKey: "broken-key" },
					fallback: { ok: true, apiKey: "fallback-key" },
				},
			},
			{ PI_IMAGE_GEN_PROVIDER: "broken" },
		);

		expect(result).toMatchObject({ providerId: "fallback", apiKey: "fallback-key" });
	});

	it("skips providers with wrong or missing chat API declarations", async () => {
		const result = await resolve({
			models: [
				model("wrong", { api: "anthropic-messages" }),
				model("missing", { api: undefined }),
				model("valid", { api: "openai-responses" }),
			],
			modelAuth: {
				wrong: { ok: true, apiKey: "wrong-key" },
				missing: { ok: true, apiKey: "missing-key" },
				valid: { ok: true, apiKey: "valid-key" },
			},
		});

		expect(result).toMatchObject({ providerId: "valid", apiKey: "valid-key" });
	});

	it("threads authHeader:true materialized headers", async () => {
		const result = await resolve({
			models: [model("header-openai")],
			modelAuth: {
				"header-openai": {
					ok: true,
					apiKey: "header-key",
					headers: { Authorization: "Bearer header-key", "X-Route": "one" },
				},
			},
		});

		expect(result).toMatchObject({
			apiKey: "header-key",
			headers: { Authorization: "Bearer header-key", "X-Route": "one" },
		});
	});

	it("keeps authHeader:false keys without synthesizing Authorization", async () => {
		const result = await resolve({
			models: [model("plain-openai")],
			modelAuth: { "plain-openai": { ok: true, apiKey: "plain-key", headers: { "X-Route": "two" } } },
		});

		expect(result).toMatchObject({ apiKey: "plain-key", headers: { "X-Route": "two" } });
		if (result.kind !== "none") expect(result.headers?.Authorization).toBeUndefined();
	});

	it("rejects headers-only gateway auth without an apiKey", async () => {
		const result = await resolve({
			models: [model("header-only-openai")],
			modelAuth: { "header-only-openai": { ok: true, headers: { "X-API-Key": "header-secret" } } },
		});

		expect(result.kind).toBe("none");
	});

	it("falls through a headers-only provider to a later keyed gateway", async () => {
		const result = await resolve({
			models: [model("headers-first"), model("keyed-second")],
			modelAuth: {
				"headers-first": { ok: true, headers: { "X-API-Key": "header-secret" } },
				"keyed-second": { ok: true, apiKey: "second-key" },
			},
		});

		expect(result).toMatchObject({ kind: "gateway", providerId: "keyed-second", apiKey: "second-key" });
	});

	it("treats a pinned headers-only provider as unavailable and falls through", async () => {
		const result = await resolve(
			{
				models: [model("pinned-headers"), model("keyed-fallback")],
				modelAuth: {
					"pinned-headers": { ok: true, headers: { "X-API-Key": "header-secret" } },
					"keyed-fallback": { ok: true, apiKey: "fallback-key" },
				},
			},
			{ PI_IMAGE_GEN_PROVIDER: "pinned-headers" },
		);

		expect(result).toMatchObject({ kind: "gateway", providerId: "keyed-fallback", apiKey: "fallback-key" });
	});

	it("rejects empty inline keys", async () => {
		const result = await resolve({
			models: [model("empty-openai")],
			modelAuth: { "empty-openai": { ok: true, apiKey: "  " } },
		});

		expect(result.kind).toBe("none");
	});

	it.each(["environment", "command"])("falls through an unresolved %s key", async (source) => {
		const result = await resolve({
			models: [model(`${source}-openai`)],
			modelAuth: { [`${source}-openai`]: { ok: false, error: `unresolved ${source} key` } },
		});

		expect(result.kind).toBe("none");
	});

	it("does not require a listed image model", async () => {
		const result = await resolve({
			models: [model("chat-only-openai", { id: "text-chat-model" })],
			modelAuth: { "chat-only-openai": { ok: true, apiKey: "chat-route-key" } },
		});

		expect(result).toMatchObject({ kind: "gateway", providerId: "chat-only-openai" });
	});

	it("uses a stored OpenAI api_key credential", async () => {
		const result = await resolve({
			storedOpenAi: { type: "api_key", key: "stored-openai-key" },
			providerAuth: { openai: { auth: { apiKey: "stored-openai-key" } } },
		});

		expect(result).toMatchObject({ kind: "native-openai", provenance: "store", providerId: "openai" });
	});

	it("skips stored OAuth entries by type instead of treating token fields as API keys", async () => {
		const result = await resolve({
			models: [model("fallback-openai")],
			storedOpenAi: { type: "oauth", access: "oauth-secret" },
			providerAuth: { openai: { auth: { apiKey: "oauth-secret" } } },
			modelAuth: { "fallback-openai": { ok: true, apiKey: "fallback-key" } },
		});

		expect(result).toMatchObject({ kind: "gateway", providerId: "fallback-openai", apiKey: "fallback-key" });
	});

	it("falls through an empty stored key", async () => {
		const result = await resolve(
			{
				storedOpenAi: { type: "api_key", key: "" },
				providerAuth: { openai: { auth: { apiKey: "\t" } } },
			},
			{ OPENAI_API_KEY: "env-key" },
		);

		expect(result).toMatchObject({ kind: "native-openai", provenance: "env", apiKey: "env-key" });
	});

	it("prefers provider ids matching openai and uses alphabetical tiebreaking", async () => {
		const result = await resolve({
			models: [model("aaa-gateway"), model("beta-openai"), model("alpha-openai")],
			modelAuth: {
				"aaa-gateway": { ok: true, apiKey: "aaa-key" },
				"beta-openai": { ok: true, apiKey: "beta-key" },
				"alpha-openai": { ok: true, apiKey: "alpha-key" },
			},
		});

		expect(result).toMatchObject({ providerId: "alpha-openai", apiKey: "alpha-key" });
	});

	it("uses a configured gateway before OPENAI_API_KEY", async () => {
		const result = await resolve(
			{
				models: [model("gateway-openai")],
				modelAuth: { "gateway-openai": { ok: true, apiKey: "gateway-key" } },
			},
			{ OPENAI_API_KEY: "env-openai-key" },
		);

		expect(result).toMatchObject({ kind: "gateway", apiKey: "gateway-key" });
	});

	it("uses OPENAI_API_KEY when it is the only source", async () => {
		const result = await resolve({}, { OPENAI_API_KEY: "env-openai-key" });

		expect(result).toEqual({
			kind: "native-openai",
			apiKey: "env-openai-key",
			baseUrl: "https://api.openai.com/v1",
			provenance: "env",
		});
	});

	it("returns key-free setup guidance naming all three setup routes", async () => {
		const result = await resolve(
			{
				models: [model("broken-openai")],
				storedOpenAi: { type: 7, key: "stored-secret-sentinel" },
				modelAuth: { "broken-openai": { ok: false, error: "bad key gateway-secret-sentinel" } },
			},
			{ PI_IMAGE_GEN_PROVIDER: "broken-openai" },
		);

		expect(result.kind).toBe("none");
		if (result.kind === "none") {
			expect(result.reason).toMatch(/store an OpenAI API key/i);
			expect(result.reason).toContain("PI_IMAGE_GEN_PROVIDER");
			expect(result.reason).toContain("OPENAI_API_KEY");
			expect(result.reason).not.toMatch(/stored-secret-sentinel|gateway-secret-sentinel/);
		}
	});
});
