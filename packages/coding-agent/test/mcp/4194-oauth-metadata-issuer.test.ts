import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";
import { beginAuthorization, completeAuthorization } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { setup } from "./fixtures/oauth-issuer-harness.ts";

// senpi#4194: exercise real SDK discovery, registration and redemption through the provider boundary.
describe("MCP OAuth metadata issuer trust", () => {
	for (const metadataIssuer of ["https://other.example.com", "https://auth.example.com:9443/tenant/"]) {
		it(`rejects a metadata document naming ${metadataIssuer}`, async () => {
			const { provider, state, fetchFn } = await setup();
			state.metadataIssuer = metadataIssuer;
			await expect(beginAuthorization(provider, { fetchFn })).rejects.toMatchObject({ oauthKind: "needs_auth" });
			expect(state.requests).toEqual([]);
		});
	}

	it("validates metadata on SDK-driven transport authentication too", async () => {
		const { provider, state, fetchFn } = await setup();
		state.metadataIssuer = "https://other.example.com";
		await expect(auth(provider, { serverUrl: provider.serverUrl, fetchFn })).rejects.toMatchObject({
			oauthKind: "needs_auth",
		});
		expect(state.requests).toEqual([]);
	});

	it("validates rediscovered metadata before a refresh sends credentials", async () => {
		const { provider, store, state, fetchFn, issuer } = await setup("configured");
		await store.write({ issuer, accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 });
		state.metadataIssuer = "https://other.example.com";
		await expect(new McpRefreshManager(provider, { fetchFn }).refresh()).rejects.toMatchObject({
			oauthKind: "needs_auth",
		});
		expect(state.requests).toEqual([]);
	});

	it("discovers a path resource without PRM using the root metadata origin", async () => {
		const { provider, state, fetchFn } = await setup();
		state.prm = false;
		state.issuer = "https://resource.example.com:8443";
		state.metadataIssuer = state.issuer;
		expect((await beginAuthorization(provider, { fetchFn })).status).toBe("redirect");
		expect(provider.discoveryState()?.authorizationServerMetadata?.issuer).toBe(state.issuer);
	});

	it("does not normalize the issuer advertised by PRM", async () => {
		const { provider, state, fetchFn } = await setup();
		state.issuer += "/";
		await expect(beginAuthorization(provider, { fetchFn })).rejects.toMatchObject({ oauthKind: "needs_auth" });
	});

	it("does not mistake a cached path issuer without PRM for the root fallback", async () => {
		const { provider, issuer } = await setup();
		await expect(
			provider.saveDiscoveryState({
				authorizationServerUrl: issuer,
				authorizationServerMetadata: {
					issuer: "https://auth.example.com:9443",
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					response_types_supported: ["code"],
				},
			}),
		).rejects.toMatchObject({ oauthKind: "needs_auth" });
	});

	it("does not normalize the issuer in root fallback metadata", async () => {
		const { provider, state, fetchFn } = await setup();
		state.prm = false;
		state.issuer = "https://resource.example.com:8443";
		state.metadataIssuer = `${state.issuer}/`;
		await expect(beginAuthorization(provider, { fetchFn })).rejects.toMatchObject({ oauthKind: "needs_auth" });
		expect(state.requests).toEqual([]);
	});

	it("accepts a configured root URL with a trailing slash without changing metadata issuers", async () => {
		const { provider, store, state, fetchFn } = await setup();
		state.prm = false;
		state.issuer = "https://resource.example.com:8443";
		state.metadataIssuer = state.issuer;
		const root = new McpOAuthProvider({
			serverName: "issuer",
			serverUrl: `${state.issuer}/`,
			store,
			redirectUrl: provider.redirectUrl,
		});
		expect((await beginAuthorization(root, { fetchFn })).status).toBe("redirect");
		expect(root.discoveryState()?.authorizationServerMetadata?.issuer).toBe(state.issuer);
	});

	it("checks a pasted error response issuer before exposing its error", async () => {
		const { provider, fetchFn } = await setup();
		await beginAuthorization(provider, { fetchFn });
		const input = new URL("http://127.0.0.1:8123/callback");
		input.search = new URLSearchParams({
			state: provider.lastAuthorizationUrl?.searchParams.get("state") ?? "",
			iss: "https://other.example.com",
			error: "untrusted-server-error",
		}).toString();
		const error = await completeAuthorization(provider, input.href, { fetchFn }).catch((cause: unknown) => cause);
		expect(error).toMatchObject({ oauthKind: "needs_auth" });
		expect(String(error)).not.toContain("untrusted-server-error");
	});

	it("rediscovers an invalid cached document after the server fixes its metadata", async () => {
		const { provider, store, fetchFn, resource, issuer } = await setup();
		await store.write({
			discoveryState: {
				authorizationServerUrl: issuer,
				resourceMetadata: { resource, authorization_servers: [issuer] },
				authorizationServerMetadata: {
					issuer: "https://wrong.example.com",
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					response_types_supported: ["code"],
				},
			},
		});

		expect((await beginAuthorization(provider, { fetchFn })).status).toBe("redirect");
		expect(provider.discoveryState()?.authorizationServerMetadata?.issuer).toBe(issuer);
	});

	it("rejects a callback before SDK discovery when its credential stamps conflict", async () => {
		const { provider, store, fetchFn } = await setup();
		await beginAuthorization(provider, { fetchFn });
		const callbackState = provider.lastAuthorizationUrl?.searchParams.get("state") ?? "";
		await store.update((current) => ({ ...current, issuer: "https://other.example.com" }));
		const requests: string[] = [];

		await expect(
			completeAuthorization(
				provider,
				`http://127.0.0.1:8123/callback?code=code&state=${callbackState}&iss=https://other.example.com`,
				{
					fetchFn: (input, init) => {
						requests.push(String(input));
						return fetchFn(input, init);
					},
				},
			),
		).rejects.toMatchObject({ oauthKind: "needs_auth" });

		expect(requests).toEqual([]);
	});
});
