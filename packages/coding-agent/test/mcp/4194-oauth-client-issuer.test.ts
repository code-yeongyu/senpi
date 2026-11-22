import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";
import {
	beginAuthorization,
	clientCredentialsGrant,
	completeAuthorization,
} from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { setup } from "./fixtures/oauth-issuer-harness.ts";

describe("MCP OAuth persisted client issuer binding", () => {
	it("does not declare a redirect application type for a client without redirects", async () => {
		const { store, resource } = await setup();
		const provider = new McpOAuthProvider({ serverName: "issuer", serverUrl: resource, store });
		expect(provider.clientMetadata.application_type).toBeUndefined();
	});
	for (const changedIssuer of [
		"https://auth.example.com:8443/tenant",
		"https://auth.example.com:9443/other",
		"https://other.example.com",
	]) {
		it(`never sends an old registration to ${changedIssuer} in a client-credentials grant`, async () => {
			const { provider, store, state, fetchFn, issuer } = await setup();
			await store.write({
				issuer,
				accessToken: "old-access",
				refreshToken: "old-refresh",
				clientInfo: { client_id: "old-client", client_secret: "old-secret", redirect_uris: [], issuer },
			});
			state.issuer = changedIssuer;
			state.metadataIssuer = changedIssuer;
			await expect(clientCredentialsGrant(provider, { fetchFn })).rejects.toMatchObject({ oauthKind: "needs_auth" });
			expect(state.requests).toEqual([]);
			expect(store.read()?.clientInfo).toBeUndefined();
			expect(store.read()?.accessToken).toBeUndefined();
		});
	}

	it("rejects a foreign registration even when the refresh token issuer matches", async () => {
		const { provider, store, state, fetchFn, issuer } = await setup();
		await store.write({
			issuer,
			accessToken: "old-access",
			refreshToken: "old-refresh",
			expiresAt: 0,
			clientInfo: { client_id: "foreign", client_secret: "old-secret", redirect_uris: [], issuer: `${issuer}/` },
		});
		await expect(new McpRefreshManager(provider, { fetchFn }).refresh()).rejects.toMatchObject({
			oauthKind: "needs_auth",
		});
		expect(state.requests).toEqual([]);
		expect(store.read()).toBeUndefined();
	});

	it("does not let the SDK reuse a slash-mismatched registration from cached discovery", async () => {
		const { provider, store, state, fetchFn, issuer } = await setup();
		await beginAuthorization(provider, { fetchFn });
		await store.update((current) => ({
			...current,
			clientInfo: { client_id: "foreign", client_secret: "old-secret", redirect_uris: [], issuer: `${issuer}/` },
		}));
		state.requests = [];
		await auth(provider, { serverUrl: provider.serverUrl, fetchFn });
		expect(state.registrations).toBe(2);
		expect(store.read()?.clientInfo?.issuer).toBe(issuer);
		expect(JSON.stringify(state.requests)).not.toContain("old-secret");
	});

	it("stamps tokens and registrations and reuses the registration after restart", async () => {
		const { provider, store, state, fetchFn, issuer, resource } = await setup();
		await beginAuthorization(provider, { fetchFn });
		const stateParam = provider.lastAuthorizationUrl?.searchParams.get("state") ?? "";
		await completeAuthorization(provider, `http://127.0.0.1:8123/callback?code=code&state=${stateParam}`, {
			fetchFn,
		});
		expect(store.read()).toMatchObject({ issuer, clientInfo: { issuer, client_id: "registered-1" } });
		const restarted = new McpOAuthProvider({
			serverName: "issuer",
			serverUrl: resource,
			store,
			redirectUrl: provider.redirectUrl,
		});
		await beginAuthorization(restarted, { fetchFn });
		expect(state.registrations).toBe(1);
		expect(JSON.parse(state.requests[0]?.body ?? "{}").application_type).toBe("native");
	});

	it("deletes a mismatched registration before a failed re-registration", async () => {
		const { provider, store, state, fetchFn, issuer } = await setup();
		await store.write({
			issuer: "https://old.example.com",
			accessToken: "old-access",
			clientInfo: { issuer: "https://old.example.com", client_id: "old-client", redirect_uris: [] },
		});
		state.rejectRegistration = true;
		await expect(beginAuthorization(provider, { fetchFn })).rejects.toThrow();
		expect(store.read()?.clientInfo).toBeUndefined();
		expect(store.read()?.accessToken).toBeUndefined();
		expect(state.requests.map((request) => request.url)).toEqual([`${issuer}/register`]);
	});

	it("keeps a configured client ID usable across issuer changes and restarts", async () => {
		const { provider, store, state, fetchFn, issuer, resource } = await setup("configured");
		await store.write({
			issuer: "https://old.example.com",
			accessToken: "old-access",
			clientInfo: {
				issuer: "https://old.example.com",
				client_id: "old-client",
				client_secret: "old-secret",
				redirect_uris: [],
			},
		});
		await clientCredentialsGrant(provider, { fetchFn });
		expect(store.read()?.issuer).toBe(issuer);
		await provider.invalidateCredentials("discovery");
		state.issuer = "https://next.example.com";
		state.metadataIssuer = state.issuer;
		const restarted = new McpOAuthProvider({
			serverName: "issuer",
			serverUrl: resource,
			store,
			clientId: "configured",
		});
		await clientCredentialsGrant(restarted, { fetchFn });
		for (const request of state.requests) {
			expect(new URLSearchParams(request.body).get("client_id")).toBe("configured");
			expect(request.body).not.toContain("old-secret");
		}
		expect(store.read()?.issuer).toBe(state.issuer);
		expect(store.read()?.clientInfo).toBeUndefined();
	});
});
