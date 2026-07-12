import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinProviders } from "../src/providers/all.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import type { OAuthProviderInterface } from "../src/utils/oauth/types.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function provider(): OAuthProviderInterface {
	const value = getOAuthProvider("gitlab-duo");
	expect(value).toBeDefined();
	if (!value) throw new Error("gitlab-duo OAuth provider is not registered");
	return value;
}

describe.sequential("GitLab Duo OAuth", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is registered and advertised by a model provider", () => {
		expect(getOAuthProvider("gitlab-duo")?.id).toBe("gitlab-duo");
		expect(builtinProviders().map((entry) => entry.id)).toContain("gitlab-duo");
	});

	it("uses PKCE with manual-code fallback and refreshes rotated credentials", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(8080, "127.0.0.1", resolve);
		});
		const bodies: URLSearchParams[] = [];
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
					bodies.push(new URLSearchParams(String(init?.body)));
					return bodies.length === 1
						? jsonResponse({ access_token: "gitlab-access", refresh_token: "gitlab-refresh", expires_in: 3600 })
						: jsonResponse({
								access_token: "gitlab-access-2",
								refresh_token: "gitlab-refresh-2",
								expires_in: 7200,
							});
				}),
			);
			let state = "";
			const credentials = await provider().login({
				onAuth: (info) => {
					const url = new URL(info.url);
					state = url.searchParams.get("state") ?? "";
					expect(url.searchParams.get("code_challenge")).toBeTruthy();
				},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => `code=manual-code&state=${state}`,
				onSelect: async () => undefined,
			});
			expect(bodies[0]?.get("grant_type")).toBe("authorization_code");
			expect(bodies[0]?.get("code_verifier")).toBeTruthy();
			expect(credentials).toMatchObject({ access: "gitlab-access", refresh: "gitlab-refresh" });

			const refreshed = await provider().refreshToken(credentials);
			expect(bodies[1]?.get("grant_type")).toBe("refresh_token");
			expect(bodies[1]?.get("refresh_token")).toBe("gitlab-refresh");
			expect(refreshed).toMatchObject({ access: "gitlab-access-2", refresh: "gitlab-refresh-2" });
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("does not expose request or response secrets on token failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "gitlab-response-private" }, 400)),
		);
		const error = await provider()
			.refreshToken({ access: "gitlab-old-private", refresh: "gitlab-refresh-private", expires: 0 })
			.catch((value: unknown) => value);
		expect(String(error)).toContain("400");
		expect(String(error)).not.toContain("gitlab-refresh-private");
		expect(String(error)).not.toContain("gitlab-response-private");
	});
});
