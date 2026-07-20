import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider } from "../src/auth/oauth/index.ts";
import { loginPerplexity, refreshPerplexityToken } from "../src/auth/oauth/perplexity.ts";
import { builtinProviders } from "../src/providers/all.ts";

const originalNoBorrow = process.env.PI_AUTH_NO_BORROW;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

describe.sequential("Perplexity OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalNoBorrow === undefined) delete process.env.PI_AUTH_NO_BORROW;
		else process.env.PI_AUTH_NO_BORROW = originalNoBorrow;
	});

	it("keeps flow helpers but does not advertise OAuth on the model provider", async () => {
		// Session JWT OAuth is not a direct api.perplexity.ai credential path.
		expect(getOAuthProvider("perplexity")).toBeUndefined();
		const { perplexityProvider } = await import("../src/providers/perplexity.ts");
		expect(perplexityProvider().auth.oauth).toBeUndefined();
		expect(perplexityProvider().auth.apiKey).toBeDefined();
		expect(builtinProviders().map((entry) => entry.id)).toContain("perplexity");
	});

	it("logs in through mocked OTP endpoints and keeps JWTs without exp non-expiring", async () => {
		// Given: a CSRF response that requires its NextAuth cookie on both OTP requests.
		process.env.PI_AUTH_NO_BORROW = "1";
		const tokenWithoutExpiry = jwt({ sub: "perplexity-account" });
		const urls: string[] = [];
		const requestCookies: (string | null)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				urls.push(url);
				if (url.endsWith("/api/auth/csrf")) {
					return new Response(JSON.stringify({ csrfToken: "csrf-value" }), {
						headers: {
							"Content-Type": "application/json",
							"Set-Cookie": "next-auth.csrf-token=cookie-value; Path=/; HttpOnly; Secure",
						},
					});
				}
				requestCookies.push(new Headers(init?.headers).get("cookie"));
				if (url.endsWith("/api/auth/signin-email")) return jsonResponse({ ok: true });
				if (url.endsWith("/api/auth/signin-otp")) return jsonResponse({ token: tokenWithoutExpiry });
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		const answers = ["member@example.com", "123456"];
		// When: the email OTP flow sends and verifies the code.
		const credentials = await loginPerplexity({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => answers.shift() ?? "",
			onSelect: async () => undefined,
		});
		// Then: both state-changing requests preserve the CSRF cookie and the JWT remains usable.
		expect(urls).toHaveLength(3);
		expect(requestCookies).toEqual(["next-auth.csrf-token=cookie-value", "next-auth.csrf-token=cookie-value"]);
		expect(credentials).toMatchObject({ access: tokenWithoutExpiry, refresh: tokenWithoutExpiry });
		expect(credentials.expires).toBe(8.64e15);

		const refreshed = await refreshPerplexityToken({ ...credentials, expires: 1 });
		expect(refreshed.access).toBe(tokenWithoutExpiry);
		expect(refreshed.expires).toBe(8.64e15);
	});

	it("uses an exp claim on refresh and keeps failed endpoint details secret", async () => {
		const exp = Math.floor(Date.now() / 1000) + 3600;
		const expiring = jwt({ exp });
		const refreshed = await refreshPerplexityToken({ access: expiring, refresh: expiring, expires: 1 });
		expect(refreshed.expires).toBe(exp * 1000 - 5 * 60_000);

		process.env.PI_AUTH_NO_BORROW = "1";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/api/auth/csrf")) {
					return new Response(JSON.stringify({ csrfToken: "csrf-private" }), {
						headers: {
							"Content-Type": "application/json",
							"Set-Cookie": "next-auth.csrf-token=private-cookie; Path=/; HttpOnly",
						},
					});
				}
				if (url.endsWith("/api/auth/signin-email")) return jsonResponse({ ok: true });
				return jsonResponse({ text: "perplexity-response-private" }, 401);
			}),
		);
		const answers = ["private@example.com", "otp-private-value"];
		const error = await loginPerplexity({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => answers.shift() ?? "",
			onSelect: async () => undefined,
		}).catch((value: unknown) => value);
		expect(String(error)).toContain("401");
		expect(String(error)).not.toContain("otp-private-value");
		expect(String(error)).not.toContain("perplexity-response-private");
	});
});
