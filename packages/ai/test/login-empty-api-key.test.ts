import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import {
	appendLoginSlot,
	type Credential,
	EmptyApiKeyError,
	listSlots,
	type PooledCredential,
} from "../src/auth/pool/slots.ts";
import type { AuthInteraction } from "../src/auth/types.ts";
import { createModels, createProvider, type Provider } from "../src/models.ts";
import { kimiCodingProvider } from "../src/providers/kimi-coding.ts";

// #3867: a keyless `login-2` slot reached auth.json because nothing refused a blank key.

function pooledApiKey(): PooledCredential {
	return {
		type: "api_key",
		key: "primary-key",
		accounts: [{ name: "default", key: "primary-key", source: "login" }],
	};
}

const blankKeys: ReadonlyArray<[string, Credential]> = [
	["an empty key", { type: "api_key", key: "" }],
	["a whitespace key", { type: "api_key", key: "   " }],
	["a key field without a value", { type: "api_key", key: undefined }],
];

describe("appendLoginSlot refuses a blank API key", () => {
	test.each(blankKeys)("refuses %s appended to an existing pool", (_label, credential) => {
		expect(() => appendLoginSlot(pooledApiKey(), credential)).toThrow(EmptyApiKeyError);
	});

	test.each(blankKeys)("refuses %s as the first credential", (_label, credential) => {
		expect(() => appendLoginSlot(undefined, credential)).toThrow(EmptyApiKeyError);
	});

	test("still saves env-only API-key logins that carry no key field", () => {
		const profile: Credential = { type: "api_key", env: { AWS_PROFILE: "work" } };
		const chain: Credential = { type: "api_key" };

		expect(appendLoginSlot(undefined, profile)).toBe(profile);
		expect(listSlots(appendLoginSlot(pooledApiKey(), chain) as PooledCredential).map((slot) => slot.name)).toEqual([
			"default",
			"login-2",
		]);
	});
});

describe("Kimi keeps its blank-key login that picks a region for KIMI_API_KEY (#3869 review)", () => {
	test("a global-region login with a blank key stores the region and resolves through KIMI_API_KEY", async () => {
		const provider = kimiCodingProvider();
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(provider);
		const answers = ["global", ""];

		await models.login(provider.id, "api_key", {
			signal: AbortSignal.timeout(5_000),
			prompt: async () => answers.shift() ?? "",
			notify: () => {},
		});

		const stored = await store.read(provider.id);
		expect(stored?.type).toBe("api_key");
		expect(Object.hasOwn(stored ?? {}, "key")).toBe(false);
		const resolved = await provider.auth.apiKey?.resolve({
			ctx: {
				env: async (name) => (name === "KIMI_API_KEY" ? "sk-kimi-env" : undefined),
				fileExists: async () => false,
			},
			credential: stored?.type === "api_key" ? stored : undefined,
			signal: AbortSignal.timeout(5_000),
		});
		expect(resolved?.auth).toMatchObject({ apiKey: "sk-kimi-env", baseUrl: "https://api.kimi.ai/coding" });
	});
});

describe("Models.login refuses a blank API key", () => {
	const provider: Provider = createProvider({
		id: "blankkey",
		name: "Blank Key",
		baseUrl: "https://blankkey.example/v1",
		auth: { apiKey: envApiKeyAuth("Blank Key API key", ["BLANKKEY_API_KEY"]) },
		models: [],
		api: "openai-responses" as never,
	});

	function submit(value: string): AuthInteraction {
		return { signal: AbortSignal.timeout(5_000), prompt: async () => value, notify: () => {} };
	}

	test("a keyed provider whose login returns key: undefined is refused", async () => {
		const keyed: Provider = createProvider({
			id: "keyed",
			name: "Keyed",
			baseUrl: "https://keyed.example/v1",
			auth: {
				apiKey: {
					name: "Keyed API key",
					login: async () => ({ type: "api_key", key: undefined }),
					resolve: async () => undefined,
				},
			},
			models: [],
			api: "openai-responses" as never,
		});
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(keyed);

		await expect(models.login("keyed", "api_key", submit(""))).rejects.toBeInstanceOf(EmptyApiKeyError);
		expect(await store.read("keyed")).toBeUndefined();
	});

	test("an empty prompt answer throws EmptyApiKeyError and writes nothing", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("blankkey", async () => pooledApiKey());
		const models = createModels({ credentials: store });
		models.setProvider(provider);

		await expect(models.login("blankkey", "api_key", submit(""))).rejects.toBeInstanceOf(EmptyApiKeyError);

		expect(listSlots((await store.read("blankkey")) as PooledCredential).map((slot) => slot.name)).toEqual([
			"default",
		]);
	});

	test("a provider that declares keyOptional saves a blank-key login without a key field", async () => {
		const optionalKey: Provider = createProvider({
			id: "optionalkey",
			name: "Optional Key",
			baseUrl: "http://127.0.0.1:8080/v1",
			auth: {
				apiKey: {
					name: "Optional Key API key",
					keyOptional: true,
					login: async () => ({
						type: "api_key",
						key: undefined,
						env: { OPTIONAL_BASE_URL: "http://127.0.0.1:8080" },
					}),
					resolve: async () => undefined,
				},
			},
			models: [],
			api: "openai-completions" as never,
		});
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(optionalKey);

		await models.login("optionalkey", "api_key", submit(""));

		const stored = await store.read("optionalkey");
		expect(stored).toEqual({ type: "api_key", env: { OPTIONAL_BASE_URL: "http://127.0.0.1:8080" } });
		expect(Object.hasOwn(stored ?? {}, "key")).toBe(false);
	});
});
