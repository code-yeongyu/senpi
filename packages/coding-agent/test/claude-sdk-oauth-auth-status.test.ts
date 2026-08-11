import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ClaudeSdkOauthCredential,
	emptyCredential,
} from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const PROVIDER = "claude-sdk-oauth";
const SENTINEL_API_KEY = "claude-sdk-oauth-managed";
const MODELS = [
	{
		id: "claude-opus-5",
		name: "Opus",
		reasoning: true,
		input: ["text"] as "text"[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];
const temporaryDirectories: string[] = [];

function makeConfig(): ModelConfig {
	const directory = mkdtempSync(join(tmpdir(), "senpi-claude-sdk-oauth-auth-status-"));
	temporaryDirectories.push(directory);
	const modelsPath = join(directory, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: {} }), "utf8");
	return ModelConfig.loadSync(modelsPath);
}

function oneAccount(): ClaudeSdkOauthCredential {
	return {
		...emptyCredential(),
		accounts: [{ name: "default", access: "a", refresh: "r", expires: Date.now() + 60_000, source: "login" }],
	};
}

type Lane = "ambient" | "oauth-slots";

function extension(lane: Lane) {
	return {
		baseUrl: PROVIDER,
		api: PROVIDER,
		apiKey: SENTINEL_API_KEY,
		models: MODELS,
		streamSimple: () => {
			throw new Error("unused in auth-status tests");
		},
		oauth: createOAuthConfig({
			readCurrent: async () => undefined,
			readSettings: () => ({ tokenInjection: lane }),
		}),
	};
}

async function checkAuth(lane: Lane, credential: ClaudeSdkOauthCredential | undefined) {
	const provider = composeModelProvider(PROVIDER, undefined, makeConfig(), extension(lane));
	const store = new InMemoryCredentialStore();
	if (credential) await store.modify(PROVIDER, async () => credential);
	const models = createModels({ credentials: store });
	models.setProvider(provider);
	return models.checkAuth(PROVIDER);
}

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

describe("claude-sdk-oauth fallback auth status", () => {
	describe("#given a managed lane and an empty sentinel credential", () => {
		describe("#when the fallback runtime checks auth", () => {
			it("#then the provider is unconfigured so the candidate is skipped", async () => {
				// given the zero-account sentinel envelope
				const credential = emptyCredential();

				// when
				const result = await checkAuth("oauth-slots", credential);

				// then
				expect(result).toBeUndefined();
			});
		});
	});

	describe("#given a managed lane and one stored login account", () => {
		describe("#when the fallback runtime checks auth", () => {
			it("#then the provider stays configured", async () => {
				// given
				const credential = oneAccount();

				// when
				const result = await checkAuth("oauth-slots", credential);

				// then
				expect(result).toEqual({ source: "OAuth", type: "oauth" });
			});
		});
	});

	describe("#given the ambient lane and an empty sentinel credential", () => {
		describe("#when the fallback runtime checks auth", () => {
			it("#then the provider stays configured because the spawned engine may hold its own login", async () => {
				// given
				const credential = emptyCredential();

				// when
				const result = await checkAuth("ambient", credential);

				// then
				expect(result).toEqual({ source: "OAuth", type: "oauth" });
			});
		});
	});

	describe("#given the ambient lane and no stored credential", () => {
		describe("#when the fallback runtime checks auth", () => {
			it("#then the provider stays configured via the sentinel api key", async () => {
				// given no stored credential

				// when
				const result = await checkAuth("ambient", undefined);

				// then
				expect(result).toEqual({ type: "api_key", source: "configured API key" });
			});
		});
	});
});
