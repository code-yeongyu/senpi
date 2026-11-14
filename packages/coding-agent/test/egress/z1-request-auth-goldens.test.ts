// Z1 goldens for request-auth composition (custody CK2, senpi#5831). These cases were recorded against the
// composition before `composeRequestAuth` was extracted, and must hold unchanged after it: composed key and
// headers (values, key order, `headers: undefined` presence), sources, env, error strings, and the order in which
// configured headers are resolved. They drive the four composition paths through their public entry points: the
// api-key auth, the ambient-only OAuth adapter, the ambient-auth extension and the extension OAuth `toAuth`.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiKeyAuth, AuthResult, OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelsJsonProvider } from "../../src/core/model-config.ts";
import { ModelConfig } from "../../src/core/model-config.ts";
import { composeApiKeyAuth } from "../../src/core/provider-api-key-auth.ts";
import { composeModelProvider, type ProviderConfigInput } from "../../src/core/provider-composer.ts";

type ResolveInput = Parameters<ApiKeyAuth["resolve"]>[0];

function input(env: Record<string, string> = {}, credential?: ResolveInput["credential"]): ResolveInput {
	return {
		ctx: { env: async (name) => env[name], fileExists: async () => false },
		signal: new AbortController().signal,
		...(credential ? { credential } : {}),
	};
}

async function resolveApiKey(
	config: ModelsJsonProvider | undefined,
	extension?: ProviderConfigInput,
	resolveInput: ResolveInput = input(),
): Promise<AuthResult | undefined> {
	const auth = composeApiKeyAuth("z1", undefined, config, extension);
	if (!auth) throw new Error("fixture composed no api-key auth");
	return auth.resolve(resolveInput);
}

const OAUTH_BASE = {
	name: "Z1 OAuth",
	login: async () => ({ refresh: "r", access: "unused", expires: 0 }),
	refreshToken: async (credential: { refresh: string; access: string; expires: number }) => credential,
	getApiKey: (credential: { access: string }) => credential.access,
};

describe("request-auth composition goldens (Z1)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "z1-request-auth-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("1: a literal key composes with no headers", async () => {
		expect(await resolveApiKey({ apiKey: "sk-literal" })).toStrictEqual({
			auth: { apiKey: "sk-literal", headers: undefined },
			source: "configured API key",
		});
	});

	it("2: authHeader composes Authorization from the resolved key", async () => {
		expect(await resolveApiKey({ apiKey: "sk-literal", authHeader: true })).toStrictEqual({
			auth: { apiKey: "sk-literal", headers: { Authorization: "Bearer sk-literal" } },
			source: "configured API key",
		});
	});

	it("3: env-template key and headers resolve from the auth context env", async () => {
		const result = await resolveApiKey(
			{ apiKey: "$Z1_KEY", headers: { "X-Org": `org-\${Z1_ORG}` } },
			undefined,
			input({ Z1_KEY: "sk-env", Z1_ORG: "o1" }),
		);
		expect(result).toStrictEqual({
			auth: { apiKey: "sk-env", headers: { "X-Org": "org-o1" } },
			source: "configured API key",
		});
	});

	it("4: a credential header alone is auth, with the header source", async () => {
		const result = await resolveApiKey({ headers: { "x-api-key": "$Z1_HDR" } }, undefined, input({ Z1_HDR: "hk" }));
		expect(result?.auth).toStrictEqual({ headers: { "x-api-key": "hk" } });
		expect(result?.source).toBeTypeOf("string");
	});

	it("5: a non-credential header alone is no auth", async () => {
		expect(await resolveApiKey({ headers: { "X-Org": "o" } })).toBeUndefined();
	});

	it("6: authHeader without a key refuses with today's message", async () => {
		await expect(resolveApiKey({ headers: { "x-api-key": "hk" }, authHeader: true })).rejects.toThrow(
			/^authHeader requires a resolved API key$/,
		);
	});

	it("7: extension headers override models.json headers, in models.json declaration order", async () => {
		const result = await resolveApiKey(
			{ apiKey: "k", headers: { "X-A": "cfg-a", "X-B": "cfg-b" } },
			{ headers: { "X-B": "ext-b", "X-C": "ext-c" } },
		);
		expect(result?.auth.headers).toStrictEqual({ "X-A": "cfg-a", "X-B": "ext-b", "X-C": "ext-c" });
		expect(Object.keys(result?.auth.headers ?? {})).toEqual(["X-A", "X-B", "X-C"]);
	});

	it("8: the composed Authorization is set last, beside a lowercase configured one", async () => {
		const result = await resolveApiKey({
			apiKey: "k",
			authHeader: true,
			headers: { authorization: "Token cfg", Authorization: "Basic cfg", "X-Z": "z" },
		});
		expect(result?.auth.headers).toStrictEqual({ authorization: "Token cfg", Authorization: "Bearer k", "X-Z": "z" });
		expect(Object.keys(result?.auth.headers ?? {})).toEqual(["authorization", "Authorization", "X-Z"]);
	});

	it("9: a stored credential wins over the configured key and lends its env to the headers", async () => {
		const result = await resolveApiKey(
			{ apiKey: "sk-config", headers: { "X-Org": "$Z1_ORG" } },
			undefined,
			input({ Z1_ORG: "from-ctx" }, { type: "api_key", key: "sk-stored", env: { Z1_ORG: "from-credential" } }),
		);
		expect(result).toStrictEqual({
			auth: { apiKey: "sk-stored", headers: { "X-Org": "from-credential" } },
			env: { Z1_ORG: "from-credential" },
			source: "stored credential",
		});
	});

	it("10: a missing header variable fails with today's description", async () => {
		await expect(resolveApiKey({ apiKey: "k", headers: { "X-Org": "$Z1_MISSING_ORG" } })).rejects.toThrow(
			/^Failed to resolve provider "z1" header "X-Org" from environment variable: Z1_MISSING_ORG$/,
		);
	});

	it("11: headers resolve one at a time, so a failing header stops the later header's command", async () => {
		const marker = join(root, "second-header-ran");
		await expect(
			resolveApiKey({
				apiKey: "k",
				headers: { "X-First": "$Z1_MISSING_FIRST", "X-Second": `!printf ran > '${marker}'; printf v` },
			}),
		).rejects.toThrow(/header "X-First"/);
		expect(existsSync(marker)).toBe(false);
	});

	it("12: the ambient-only OAuth adapter composes headers and Authorization over the ambient key", async () => {
		const result = await resolveApiKey(undefined, {
			oauth: {
				...OAUTH_BASE,
				resolveAmbient: async () => ({ auth: { apiKey: "ambient-key" }, source: "ambient" }),
			},
			headers: { "X-A": "a" },
			authHeader: true,
		});
		expect(result).toStrictEqual({
			auth: { apiKey: "ambient-key", headers: { "X-A": "a", Authorization: "Bearer ambient-key" } },
			source: "ambient",
		});
	});

	it("13: the ambient-auth extension composes headers and keeps stored env over ambient env", async () => {
		const result = await resolveApiKey(
			undefined,
			{
				ambientAuth: {
					resolve: async () => ({ auth: { apiKey: "adc" }, env: { REGION: "ambient" }, ambient: true }),
				},
				headers: { "X-G": "g" },
				authHeader: true,
			},
			input({}, { type: "api_key", env: { REGION: "stored" } }),
		);
		expect(result).toStrictEqual({
			auth: { apiKey: "adc", headers: { "X-G": "g", Authorization: "Bearer adc" } },
			env: { REGION: "stored" },
			ambient: true,
			source: undefined,
		});
	});

	it("14: extension OAuth toAuth composes headers from the credential env and Authorization", async () => {
		const provider = composeModelProvider("z1", undefined, await ModelConfig.load(undefined), {
			oauth: OAUTH_BASE,
			headers: { "X-O": "$Z1_OAUTH_ENV" },
			authHeader: true,
		});
		const credential = {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: 0,
			env: { Z1_OAUTH_ENV: "from-credential" },
		} as OAuthCredential;
		expect(await provider.auth.oauth?.toAuth(credential)).toStrictEqual({
			apiKey: "tok",
			headers: { "X-O": "from-credential", Authorization: "Bearer tok" },
		});
	});
});
