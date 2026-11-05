// Brain/hand split plan row S16c (F16): one MCP extension instance serving several execution scopes keeps an
// HTTP server's OAuth state shared by the runtime and reports it to every scope; a later scope neither loses the
// stored authorization nor sees another scope's server state.
import { afterEach, describe, expect, it } from "vitest";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { createTestUiContext } from "../suite/harness.ts";
import { sharingHttpFixture } from "../mcp/fixtures/sharing-http.ts";
import { spawnOAuthIdp } from "../mcp/fixtures/spawn-idp.ts";
import { type McpScopedRuntime, type McpScopedRuntimeOptions, mcpRuntimeWithScopes } from "./scope-mcp-harness.ts";

const runtimes: McpScopedRuntime[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	for (const close of closers.splice(0).reverse()) await close();
});

async function twoScopes(options: Omit<McpScopedRuntimeOptions, "uis">) {
	const created = await mcpRuntimeWithScopes({ ...options, uis: [createTestUiContext(), createTestUiContext()] });
	runtimes.push(created);
	const [a, b] = created.scopes;
	if (a === undefined || b === undefined) throw new Error("two scopes expected");
	await created.attach(a);
	await created.attach(b);
	return { ...created, a, b };
}

describe("MCP HTTP/OAuth state across execution scopes (S16c)", () => {
	it("MULTI: an authorized OAuth server serves every scope with its stored token over one connection", async () => {
		// Given an OAuth HTTP server with a stored token, and scopes A and B of one runtime, A attached first.
		const fixture = await sharingHttpFixture();
		closers.push(fixture.close);
		const { a, b, call, inventory } = await twoScopes({
			servers: { fx: { type: "http", url: fixture.url, auth: "oauth", exposure: "direct", requestTimeoutMs: 4000 } },
			prepare: async (agentDir) => {
				const store = new McpTokenStore({ serverName: "fx", serverUrl: fixture.url, agentDir });
				await store.update(() => ({
					accessToken: "stored",
					refreshToken: "refresh",
					expiresAt: Date.now() + 3_600_000,
				}));
			},
		});

		// When A calls, then B calls.
		const fromA = await call(a, "mcp_fx_echo", { value: "A" });
		const fromB = await call(b, "mcp_fx_echo", { value: "B" });

		// Then both calls were served with the stored token on the runtime's one connection.
		expect([fromA, fromB]).toEqual([JSON.stringify({ value: "A" }), JSON.stringify({ value: "B" })]);
		expect(fixture.callAuthorizations).toEqual(["Bearer stored", "Bearer stored"]);
		expect(fixture.connects).toBe(1);
		// And each scope's inventory reports the server connected and logged in.
		for (const scope of [a, b]) {
			expect((await inventory(scope.sessionId))?.servers).toMatchObject([
				{ name: "fx", status: "connected", authStatus: "oAuth" },
			]);
		}
	});

	it("MULTI: an OAuth server still needing authorization reports needs_auth to every scope", async () => {
		// Given an OAuth HTTP server nobody has authorized, and scopes A and B of one runtime.
		const idp = await spawnOAuthIdp();
		closers.push(idp.cleanup);
		const { a, b, inventory } = await twoScopes({
			servers: { fix: { type: "http", url: idp.mcpUrl, auth: "oauth", exposure: "direct", startupTimeoutMs: 2000 } },
		});

		// When each scope asks for its inventory.
		// Then both report the server as needing authorization, with no tools.
		for (const scope of [a, b]) {
			expect((await inventory(scope.sessionId))?.servers).toMatchObject([
				{ name: "fix", status: "needs_auth", authStatus: "notLoggedIn", tools: [] },
			]);
		}
	});
});
