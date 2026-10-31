import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach } from "vitest";
import { McpOAuthProvider } from "../../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function setup(clientId?: string) {
	const root = await mkdtemp(join(tmpdir(), "mcp-4194-"));
	roots.push(root);
	const resource = "https://resource.example.com:8443/mcp";
	const issuer = "https://auth.example.com:9443/tenant";
	const store = new McpTokenStore({ agentDir: root, serverName: "issuer", serverUrl: resource });
	const provider = new McpOAuthProvider({
		serverName: "issuer",
		serverUrl: resource,
		store,
		clientId,
		redirectUrl: "http://127.0.0.1:8123/callback",
	});
	const requests: { url: string; body: string }[] = [];
	const state = {
		issuer,
		metadataIssuer: issuer,
		prm: true,
		metadata: true,
		registration: true,
		rejectRegistration: false,
		registrations: 0,
		requests,
	};
	const fetchFn: FetchLike = async (input, init) => {
		const url = String(input);
		if (url.includes("oauth-protected-resource")) {
			return state.prm
				? Response.json({ resource, authorization_servers: [state.issuer] })
				: new Response(null, { status: 404 });
		}
		if (url.includes(".well-known")) {
			if (!state.metadata) return new Response(null, { status: 404 });
			return Response.json({
				issuer: state.metadataIssuer,
				authorization_endpoint: `${state.issuer}/authorize`,
				token_endpoint: `${state.issuer}/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				...(state.registration ? { registration_endpoint: `${state.issuer}/register` } : {}),
			});
		}
		state.requests.push({ url, body: String(init?.body ?? "") });
		if (url.endsWith("/register")) {
			state.registrations++;
			return state.rejectRegistration
				? new Response(null, { status: 400 })
				: Response.json({ client_id: `registered-${state.registrations}`, redirect_uris: [] });
		}
		return Response.json({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer" });
	};
	return { provider, store, state, fetchFn, resource, issuer };
}
