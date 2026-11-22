import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";
import { clientCredentialsGrant, completeAuthorization } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { setup } from "./fixtures/oauth-issuer-harness.ts";

// senpi#4194 review: the SDK stamped root-fallback sign-ins with an origin's trailing slash.
describe("MCP OAuth root-fallback credential continuity", () => {
	for (const flow of ["sdk", "refresh-manager"] as const) {
		it(`refreshes a legacy root-fallback sign-in without registration through ${flow}`, async () => {
			const { provider, store, state, fetchFn, resource } = await setup();
			const issuer = new URL(resource).origin;
			state.prm = false;
			state.issuer = issuer;
			state.metadataIssuer = issuer;
			await store.write({
				issuer: `${issuer}/`,
				accessToken: "legacy-access",
				refreshToken: "legacy-refresh",
				expiresAt: 0,
				clientInfo: { issuer: `${issuer}/`, client_id: "legacy-client", redirect_uris: [] },
				discoveryState: {
					authorizationServerUrl: `${issuer}/`,
					authorizationServerMetadata: {
						issuer,
						authorization_endpoint: `${issuer}/authorize`,
						token_endpoint: `${issuer}/token`,
						response_types_supported: ["code"],
						code_challenge_methods_supported: ["S256"],
					},
				},
			});

			if (flow === "sdk") {
				expect(await auth(provider, { serverUrl: resource, fetchFn })).toBe("AUTHORIZED");
			} else {
				expect((await new McpRefreshManager(provider, { fetchFn }).refresh()).access_token).toBe("new-access");
			}

			expect(state.registrations).toBe(0);
			expect(state.requests).toHaveLength(1);
			expect(state.requests[0]?.url).toBe(`${issuer}/token`);
			expect(new URLSearchParams(state.requests[0]?.body).get("client_id")).toBe("legacy-client");
			expect(new URLSearchParams(state.requests[0]?.body).get("grant_type")).toBe("refresh_token");
			expect(provider.discoveryState()).toBeDefined();
			expect(provider.tokens()?.issuer).toBe(issuer);
		});
	}

	it("keeps client-credentials tokens on the next read without authorization-server metadata", async () => {
		const { provider, state, fetchFn, resource } = await setup("configured");
		const issuer = new URL(resource).origin;
		state.prm = false;
		state.metadata = false;
		state.issuer = issuer;

		await clientCredentialsGrant(provider, { fetchFn });

		expect(provider.discoveryState()).toMatchObject({ authorizationServerUrl: issuer });
		expect(provider.tokens()).toMatchObject({ issuer, access_token: "new-access" });
	});

	it("stamps SDK-registered clients and code tokens without authorization-server metadata", async () => {
		const { provider, store, state, fetchFn, resource } = await setup();
		const issuer = new URL(resource).origin;
		state.prm = false;
		state.metadata = false;
		state.issuer = issuer;
		expect(await auth(provider, { serverUrl: resource, fetchFn })).toBe("REDIRECT");
		const callbackState = provider.lastAuthorizationUrl?.searchParams.get("state") ?? "";

		await completeAuthorization(provider, `http://127.0.0.1:8123/callback?code=code&state=${callbackState}`, {
			fetchFn,
		});

		expect(provider.discoveryState()).toMatchObject({ authorizationServerUrl: issuer });
		expect(store.read()).toMatchObject({ issuer, clientInfo: { issuer, client_id: "registered-1" } });
		expect(provider.tokens()?.access_token).toBe("new-access");
		expect(state.registrations).toBe(1);
	});

	for (const nextIssuer of [
		"https://resource.example.com:8443/tenant",
		"https://resource.example.com:9443",
		"https://other.example.com:8443",
	]) {
		it(`does not treat legacy root stamps as belonging to ${nextIssuer}`, async () => {
			const { provider, store, state, fetchFn, resource } = await setup();
			const issuer = `${new URL(resource).origin}/`;
			await store.write({
				issuer,
				accessToken: "legacy-access",
				refreshToken: "legacy-refresh",
				clientInfo: { issuer, client_id: "legacy-client", client_secret: "old-secret", redirect_uris: [] },
			});
			state.issuer = nextIssuer;
			state.metadataIssuer = nextIssuer;

			await expect(clientCredentialsGrant(provider, { fetchFn })).rejects.toMatchObject({ oauthKind: "needs_auth" });

			expect(state.requests).toEqual([]);
			expect(store.read()?.clientInfo).toBeUndefined();
			expect(store.read()?.accessToken).toBeUndefined();
		});
	}
});
