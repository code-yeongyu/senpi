import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinProviders } from "../src/providers/all.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import type { OAuthProviderInterface } from "../src/utils/oauth/types.ts";

const originalNoBorrow = process.env.PI_AUTH_NO_BORROW;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function provider(): OAuthProviderInterface {
	const value = getOAuthProvider("perplexity");
	expect(value).toBeDefined();
	if (!value) throw new Error("perplexity OAuth provider is not registered");
	return value;
}

describe.sequential("Perplexity OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalNoBorrow === undefined) delete process.env.PI_AUTH_NO_BORROW;
		else process.env.PI_AUTH_NO_BORROW = originalNoBorrow;
	});

	it("is registered and advertised by a model provider", () => {
		expect(getOAuthProvider("perplexity")?.id).toBe("perplexity");
		expect(builtinProviders().map((entry) => entry.id)).toContain("perplexity");
	});

	it("logs in through mocked OTP endpoints and keeps JWTs without exp non-expiring", async () => {
		process.env.PI_AUTH_NO_BORROW = "1";
		const tokenWithoutExpiry = jwt({ sub: "perplexity-account" });
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				urls.push(url);
				if (url.endsWith("/api/auth/csrf")) return jsonResponse({ csrfToken: "csrf-value" });
				if (url.endsWith("/api/auth/signin-email")) return jsonResponse({ ok: true });
				if (url.endsWith("/api/auth/signin-otp")) return jsonResponse({ token: tokenWithoutExpiry });
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		const answers = ["member@example.com", "123456"];
		const credentials = await provider().login({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => answers.shift() ?? "",
			onSelect: async () => undefined,
		});
		expect(urls).toHaveLength(3);
		expect(credentials).toMatchObject({ access: tokenWithoutExpiry, refresh: tokenWithoutExpiry });
		expect(credentials.expires).toBe(8.64e15);

		const refreshed = await provider().refreshToken({ ...credentials, expires: 1 });
		expect(refreshed.access).toBe(tokenWithoutExpiry);
		expect(refreshed.expires).toBe(8.64e15);
	});

	it("uses an exp claim on refresh and keeps failed endpoint details secret", async () => {
		const exp = Math.floor(Date.now() / 1000) + 3600;
		const expiring = jwt({ exp });
		const refreshed = await provider().refreshToken({ access: expiring, refresh: expiring, expires: 1 });
		expect(refreshed.expires).toBe(exp * 1000 - 5 * 60_000);

		process.env.PI_AUTH_NO_BORROW = "1";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/api/auth/csrf")) return jsonResponse({ csrfToken: "csrf-private" });
				if (url.endsWith("/api/auth/signin-email")) return jsonResponse({ ok: true });
				return jsonResponse({ text: "perplexity-response-private" }, 401);
			}),
		);
		const answers = ["private@example.com", "otp-private-value"];
		const error = await provider()
			.login({
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => answers.shift() ?? "",
				onSelect: async () => undefined,
			})
			.catch((value: unknown) => value);
		expect(String(error)).toContain("401");
		expect(String(error)).not.toContain("otp-private-value");
		expect(String(error)).not.toContain("perplexity-response-private");
	});
});
