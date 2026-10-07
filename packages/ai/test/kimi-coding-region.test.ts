import { afterEach, describe, expect, it, vi } from "vitest";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import type { AuthContext, AuthPrompt, ProviderAuthInteraction } from "../src/auth/types.ts";
import { kimiCodingProvider } from "../src/providers/kimi-coding.ts";

const MAINLAND_OAUTH_HOST = "https://auth.kimi.com";
const GLOBAL_OAUTH_HOST = "https://auth.kimi.ai";
const GLOBAL_API_BASE_URL = "https://api.kimi.ai/coding";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deviceAuthorizationResponse(host: string): Response {
	return jsonResponse({
		user_code: "ABCD-1234",
		device_code: "device-code-123",
		verification_uri: `${host}/code`,
		verification_uri_complete: `${host}/code?user_code=ABCD-1234`,
		interval: 1,
		expires_in: 600,
	});
}

function stubOAuthFetch(urls: string[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith("/api/oauth/device_authorization")) {
				return deviceAuthorizationResponse(new URL(url).origin);
			}
			if (url.endsWith("/api/oauth/token")) {
				return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		}),
	);
}

function interactionAnswering(answers: Record<string, string>, prompts: AuthPrompt[] = []): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		prompt: async (prompt) => {
			prompts.push(prompt);
			const answer = answers[prompt.type];
			if (answer === undefined) throw new Error(`Unexpected ${prompt.type} prompt: ${prompt.message}`);
			return answer;
		},
		notify: () => {},
	};
}

function authContext(env: Record<string, string>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

describe("Kimi Code regions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	describe("#given an OAuth login", () => {
		it("offers both regions and stores the chosen one with the credential", async () => {
			vi.useFakeTimers();
			const urls: string[] = [];
			const prompts: AuthPrompt[] = [];
			stubOAuthFetch(urls);

			const login = kimiCodingOAuth.login(interactionAnswering({ select: "global" }, prompts));
			await vi.advanceTimersByTimeAsync(2_000);
			const credential = await login;

			expect(prompts).toHaveLength(1);
			const prompt = prompts[0];
			expect(prompt?.type).toBe("select");
			if (prompt?.type !== "select") throw new Error("expected a select prompt");
			expect(prompt.options.map((option) => option.id)).toEqual(["mainland-cn", "global"]);
			expect(urls).toEqual([
				`${GLOBAL_OAUTH_HOST}/api/oauth/device_authorization`,
				`${GLOBAL_OAUTH_HOST}/api/oauth/token`,
			]);
			expect(credential).toMatchObject({ type: "oauth", access: "access", env: { KIMI_CODE_REGION: "global" } });
		});

		it("skips the prompt when KIMI_CODE_REGION names the region", async () => {
			vi.useFakeTimers();
			vi.stubEnv("KIMI_CODE_REGION", "global");
			const urls: string[] = [];
			stubOAuthFetch(urls);

			const login = kimiCodingOAuth.login(interactionAnswering({}));
			await vi.advanceTimersByTimeAsync(2_000);
			const credential = await login;

			expect(urls[0]).toBe(`${GLOBAL_OAUTH_HOST}/api/oauth/device_authorization`);
			expect(credential).toMatchObject({ env: { KIMI_CODE_REGION: "global" } });
		});

		it("keeps a custom KIMI_CODE_OAUTH_HOST with the credential without inventing a region", async () => {
			vi.useFakeTimers();
			vi.stubEnv("KIMI_CODE_OAUTH_HOST", "https://auth.example.com/");
			const urls: string[] = [];
			stubOAuthFetch(urls);

			const login = kimiCodingOAuth.login(interactionAnswering({}));
			await vi.advanceTimersByTimeAsync(2_000);
			const credential = await login;

			expect(urls[0]).toBe("https://auth.example.com/api/oauth/device_authorization");
			expect(credential.env).toEqual({ KIMI_CODE_OAUTH_HOST: "https://auth.example.com" });
		});
	});

	describe("#given a stored credential", () => {
		it("refreshes an international credential at kimi.ai even when the env points at kimi.com", async () => {
			vi.stubEnv("KIMI_CODE_OAUTH_HOST", MAINLAND_OAUTH_HOST);
			const urls: string[] = [];
			stubOAuthFetch(urls);

			await kimiCodingOAuth.refresh(
				{ type: "oauth", access: "old", refresh: "old-refresh", expires: 0, env: { KIMI_CODE_REGION: "global" } },
				new AbortController().signal,
			);

			expect(urls).toEqual([`${GLOBAL_OAUTH_HOST}/api/oauth/token`]);
		});

		it("refreshes a credential that predates regions at the env host, then kimi.com", async () => {
			const urls: string[] = [];
			stubOAuthFetch(urls);
			const legacy = { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 } as const;

			await kimiCodingOAuth.refresh(legacy, new AbortController().signal);
			vi.stubEnv("KIMI_OAUTH_HOST", GLOBAL_OAUTH_HOST);
			await kimiCodingOAuth.refresh(legacy, new AbortController().signal);

			expect(urls).toEqual([`${MAINLAND_OAUTH_HOST}/api/oauth/token`, `${GLOBAL_OAUTH_HOST}/api/oauth/token`]);
		});

		it("routes international requests to api.kimi.ai and leaves the mainland base untouched", async () => {
			const international = await kimiCodingOAuth.toAuth({
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				env: { KIMI_CODE_REGION: "global" },
			});
			const mainland = await kimiCodingOAuth.toAuth({
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				env: { KIMI_CODE_REGION: "mainland-cn" },
			});
			const legacy = await kimiCodingOAuth.toAuth({
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
			});

			expect(international.baseUrl).toBe(GLOBAL_API_BASE_URL);
			expect(international.headers?.Authorization).toBe("Bearer access");
			expect(mainland.baseUrl).toBeUndefined();
			expect(legacy.baseUrl).toBeUndefined();
		});
	});

	describe("#given an API key", () => {
		it("collects the region with the key and routes stored keys by it", async () => {
			const apiKey = kimiCodingProvider().auth.apiKey;
			if (!apiKey?.login) throw new Error("Kimi Code api-key login is missing");
			const prompts: AuthPrompt[] = [];

			const credential = await apiKey.login(interactionAnswering({ select: "global", secret: "sk-kimi" }, prompts));
			const resolved = await apiKey.resolve({
				ctx: authContext({}),
				credential,
				signal: new AbortController().signal,
			});

			expect(prompts.map((prompt) => prompt.type)).toEqual(["select", "secret"]);
			expect(credential).toEqual({ type: "api_key", key: "sk-kimi", env: { KIMI_CODE_REGION: "global" } });
			expect(resolved?.auth).toEqual({ apiKey: "sk-kimi", baseUrl: GLOBAL_API_BASE_URL });
			expect(resolved?.env).toEqual({ KIMI_CODE_REGION: "global" });
		});

		it("routes an env key by KIMI_CODE_REGION and keeps the mainland base by default", async () => {
			const apiKey = kimiCodingProvider().auth.apiKey;
			if (!apiKey) throw new Error("Kimi Code api-key auth is missing");
			const signal = new AbortController().signal;

			const international = await apiKey.resolve({
				ctx: authContext({ KIMI_API_KEY: "sk-env", KIMI_CODE_REGION: "global" }),
				credential: undefined,
				signal,
			});
			const mainland = await apiKey.resolve({
				ctx: authContext({ KIMI_API_KEY: "sk-env" }),
				credential: undefined,
				signal,
			});

			expect(international?.auth).toEqual({ apiKey: "sk-env", baseUrl: GLOBAL_API_BASE_URL });
			expect(international?.source).toBe("KIMI_API_KEY");
			expect(mainland?.auth).toEqual({ apiKey: "sk-env" });
		});
	});
});
