import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { storedKeyHint, verifyApiKey } from "../../src/core/verify-api-key.ts";

const KEY = "sk-test-0123456789abcd";

const model = (provider: string, api: Api, baseUrl: string) =>
	({ id: "m", name: "m", provider, api, baseUrl }) as unknown as Model<Api>;

const MODELS = [
	model("openai", "openai-completions", "https://api.example.test/v1/"),
	model("anthropic", "anthropic-messages", "https://anthropic.example.test/v1"),
	model("mistral", "mistral-conversations", "https://mistral.example.test"),
	model("odd", "bedrock-converse-stream" as Api, "https://bedrock.example.test"),
];

// `status` answers KEY; any other key (the made-up control key) gets `others`, as a provider that
// checks keys answers 401. A public model list answers 200 to every key.
const answering = (status: number, others = 401) => {
	const seen: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetch = (async (url: string, init?: RequestInit) => {
		const headers = init?.headers as Record<string, string>;
		seen.push({ url, headers });
		const sent = headers.authorization ?? headers["x-api-key"] ?? "";
		return new Response(null, { status: sent.includes(KEY) ? status : others });
	}) as unknown as typeof globalThis.fetch;
	return { fetch, seen };
};

const verify = (provider: string, fetch: typeof globalThis.fetch) =>
	verifyApiKey({ models: MODELS, provider, key: KEY, signal: AbortSignal.timeout(5_000), fetch });

describe("verifyApiKey (desktop #2510)", () => {
	it("reads the provider's model list with the key and answers ok on 2xx", async () => {
		const provider = answering(200);
		expect(await verify("openai", provider.fetch)).toEqual({ ok: true });
		expect(provider.seen[0]?.url).toBe("https://api.example.test/v1/models");
		expect(provider.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
	});

	// #3372 review: OpenRouter's and keyless servers' model lists answer any key.
	it("does not call a key valid when the model list answers any key", async () => {
		expect(await verify("openai", answering(200, 200).fetch)).toEqual({ ok: false, reason: "unsupported" });
	});

	// #3372 delta review: a temporary failure is "try again", never "cannot be checked".
	it("reports a rate limit or outage as unreachable, on either request", async () => {
		expect(await verify("openai", answering(429).fetch)).toEqual({ ok: false, reason: "unreachable", status: 429 });
		expect(await verify("openai", answering(200, 429).fetch)).toEqual({
			ok: false,
			reason: "unreachable",
			status: 429,
		});
		expect(await verify("openai", answering(200, 503).fetch)).toEqual({
			ok: false,
			reason: "unreachable",
			status: 503,
		});
		let calls = 0;
		const controlOffline = (async () => {
			calls += 1;
			if (calls === 1) return new Response(null, { status: 200 });
			throw new TypeError("fetch failed");
		}) as unknown as typeof globalThis.fetch;
		expect(await verify("openai", controlOffline)).toEqual({ ok: false, reason: "unreachable" });
	});

	it("probes Mistral's list under /v1", async () => {
		const provider = answering(200);
		expect(await verify("mistral", provider.fetch)).toEqual({ ok: true });
		expect(provider.seen[0]?.url).toBe("https://mistral.example.test/v1/models");
	});

	it("drops configured auth headers whatever their case", async () => {
		const provider = answering(200);
		const withHeaders = [
			{ ...MODELS[0], headers: { Authorization: "Bearer configured", "X-Extra": "1" } } as unknown as Model<Api>,
		];
		await verifyApiKey({
			models: withHeaders,
			provider: "openai",
			key: KEY,
			signal: AbortSignal.timeout(5_000),
			fetch: provider.fetch,
		});
		expect(
			Object.keys(provider.seen[0]?.headers ?? {}).filter((name) => name.toLowerCase() === "authorization"),
		).toEqual(["authorization"]);
		expect(provider.seen[0]?.headers["X-Extra"]).toBe("1");
	});

	it("uses the Anthropic header and path", async () => {
		const provider = answering(200);
		await verify("anthropic", provider.fetch);
		expect(provider.seen[0]?.url).toBe("https://anthropic.example.test/v1/models");
		expect(provider.seen[0]?.headers["x-api-key"]).toBe(KEY);
	});

	it("tells a rejected key from an unreachable provider and an unchecked one", async () => {
		expect(await verify("openai", answering(401).fetch)).toEqual({ ok: false, reason: "rejected", status: 401 });
		expect(await verify("openai", answering(403).fetch)).toEqual({ ok: false, reason: "rejected", status: 403 });
		expect(await verify("openai", answering(503).fetch)).toEqual({
			ok: false,
			reason: "unreachable",
			status: 503,
		});
		expect(await verify("openai", answering(404).fetch)).toEqual({
			ok: false,
			reason: "unsupported",
			status: 404,
		});
		expect(await verify("openai", answering(302).fetch)).toEqual({
			ok: false,
			reason: "unsupported",
			status: 302,
		});
		const offline = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof globalThis.fetch;
		expect(await verify("openai", offline)).toEqual({ ok: false, reason: "unreachable" });
		expect(await verify("odd", answering(200).fetch)).toEqual({ ok: false, reason: "unsupported" });
		expect(await verify("nobody", answering(200).fetch)).toEqual({ ok: false, reason: "unknown-provider" });
	});

	it("never puts the key in its answer", async () => {
		for (const status of [200, 401, 500]) {
			expect(JSON.stringify(await verify("openai", answering(status).fetch))).not.toContain(KEY);
		}
	});
});

const registryWith = (credential: unknown) => ({ authStorage: { get: () => credential } }) as unknown as ModelRegistry;

describe("storedKeyHint (desktop #2510)", () => {
	it("shows exactly the last four characters of an app-stored key", () => {
		expect(storedKeyHint(registryWith({ type: "api_key", key: KEY }), { id: "openai", authType: "api_key" })).toEqual(
			{
				keyHint: "abcd",
			},
		);
	});

	it("hints nothing for OAuth, command or env references, or short keys", () => {
		const row = { id: "openai", authType: "api_key" as const };
		expect(storedKeyHint(registryWith({ type: "oauth" }), row)).toEqual({});
		expect(storedKeyHint(registryWith({ type: "api_key", key: KEY }), { id: "openai", authType: "oauth" })).toEqual(
			{},
		);
		expect(storedKeyHint(registryWith({ type: "api_key", key: "!op read op://vault/key" }), row)).toEqual({});
		expect(storedKeyHint(registryWith({ type: "api_key", key: "$OPENAI_API_KEY" }), row)).toEqual({});
		expect(storedKeyHint(registryWith({ type: "api_key", key: "short-key" }), row)).toEqual({});
		expect(storedKeyHint(registryWith(undefined), row)).toEqual({});
	});
});
