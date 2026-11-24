import { writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import {
	legacyMcpCredentialIdentity,
	mcpCredentialIdentity,
} from "../../../src/core/extensions/builtin/mcp/auth/catalog-identity.ts";
import { resolveServerAuth } from "../../../src/core/extensions/builtin/mcp/auth/context.ts";
import {
	beginAuthorization,
	clientCredentialsGrant,
	completeAuthorization,
} from "../../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import type { McpStoredAuth } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { textContent } from "../../mcp/fixtures/register-call.ts";
import { createHarness, createTestUiContext, getToolResult } from "../harness.ts";
import { oauthHarness } from "./2861-mcp-oauth-support.ts";

// #2861: scope is granted authorization, not the configured request or metadata's supported scopes.
for (const [name, args, continuous, expectedScope] of [
	["equal normalized scope", ["--refresh-scope", "offline_access mcp mcp"], true, "mcp offline_access"],
	["omitted scope", ["--omit-refresh-scope"], true, "mcp offline_access"],
	["narrowed scope", ["--refresh-scope", "mcp"], false, "mcp"],
	["broader scope", ["--refresh-scope", "mcp offline_access write"], false, "mcp offline_access write"],
	["malformed scope", ["--refresh-scope", "mcp\twrite"], false, undefined],
] as const) {
	it(`retains an offer only for ${name} with proven original grant scope`, async () => {
		const harness = await oauthHarness(false, "lazy", [...args]);
		try {
			await harness.signIn();
			const owner = await harness.attach();
			const before = harness.store.read();
			await harness.expire();
			const result = await owner.call("scope");
			const after = harness.store.read();
			expect(after?.scope).toBe(expectedScope);
			expect(after?.refreshScope).toBe("mcp offline_access");
			if (continuous) {
				expect(textContent(result)).toBe("fixture tool_1 value=scope mode=alpha");
				expect(after?.authorization?.id).toBe(before?.authorization?.id);
				expect(after?.authorization?.proof?.previousCredentialIdentity).toBe(
					before?.authorization?.proof?.credentialIdentity,
				);
			} else {
				expect(result).toHaveProperty("details.error.kind", "unavailable");
				expect(after?.authorization?.id).not.toBe(before?.authorization?.id);
			}
			expect(
				(await harness.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
			).toHaveLength(continuous ? 1 : 0);
		} finally {
			await harness.cleanup();
		}
	});
}

function activeRegistration(record: McpStoredAuth) {
	if (record.clientInfo === undefined) throw new Error("missing authentic registration");
	return record.clientInfo;
}

const mutations: readonly [string, (record: McpStoredAuth) => McpStoredAuth][] = [
	["access token", (record) => ({ ...record, accessToken: "synthetic-replacement" })],
	["refresh token", (record) => ({ ...record, refreshToken: "synthetic-replacement" })],
	["issuer", (record) => ({ ...record, issuer: "https://other.example" })],
	["resource", (record) => ({ ...record, resource: "https://other.example/mcp" })],
	["client ID", (record) => ({ ...record, clientInfo: { ...activeRegistration(record), client_id: "replacement" } })],
	[
		"client secret",
		(record) => ({
			...record,
			clientInfo: {
				...activeRegistration(record),
				client_secret: "synthetic-secret",
			},
		}),
	],
	[
		"client auth method",
		(record) => ({
			...record,
			clientInfo: {
				...activeRegistration(record),
				token_endpoint_auth_method: "client_secret_post",
			},
		}),
	],
	["scope", (record) => ({ ...record, scope: "write" })],
	["original scope", (record) => ({ ...record, refreshScope: "write" })],
	["missing proof", (record) => ({ ...record, authorization: undefined })],
	[
		"current commitment",
		(record) => {
			const authorization = record.authorization;
			if (authorization?.proof === undefined) throw new Error("missing authentic proof");
			return {
				...record,
				authorization: { ...authorization, proof: { ...authorization.proof, credentialIdentity: "0".repeat(64) } },
			};
		},
	],
];
for (const [name, mutate] of mutations) {
	it(`refuses retained offers after external ${name} replacement with copied provenance`, async () => {
		const harness = await oauthHarness(false, "lazy");
		try {
			await harness.signIn();
			const owner = await harness.attach();
			await harness.store.update((record) => {
				if (record === undefined) throw new Error("missing authentic grant");
				return mutate(record);
			});
			expect(await owner.call("replaced")).toHaveProperty("details.error.kind", "unavailable");
			expect(
				(await harness.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
			).toHaveLength(0);
		} finally {
			await harness.cleanup();
		}
	});
}

for (const corruption of ["unsupported version", "malformed proof"] as const) {
	it(`refuses authorization provenance with ${corruption}`, async () => {
		const harness = await oauthHarness(false, "lazy");
		try {
			await harness.signIn();
			const owner = await harness.attach();
			const record = harness.store.read();
			const authentic = record?.authorization;
			if (authentic?.proof === undefined) throw new Error("missing authentic proof");
			const authorization =
				corruption === "unsupported version"
					? { ...authentic, version: 2 }
					: { ...authentic, proof: { ...authentic.proof, previousCredentialIdentity: 123 } };
			await writeFile(harness.store.tokensPath, JSON.stringify({ ...record, authorization }));
			expect(await owner.call("corrupt")).toHaveProperty("details.error.kind", "unavailable");
			expect(
				(await harness.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
			).toHaveLength(0);
		} finally {
			await harness.cleanup();
		}
	});
}

it("never transfers an offer to a completed fresh authorization of the same issuer and scope", async () => {
	const harness = await oauthHarness(true, "lazy");
	try {
		await harness.signIn();
		const owner = await harness.attach();
		const epoch = harness.store.read()?.authorization?.id;
		await harness.signIn();
		expect(harness.store.read()?.authorization?.id).not.toBe(epoch);
		expect(await owner.call("reauthorized")).toHaveProperty("details.error.kind", "unavailable");
		expect(
			(await harness.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
		).toHaveLength(0);
	} finally {
		await harness.cleanup();
	}
});

it.each([false, true])(
	"attributes fresh client-credentials without an inherited user grant (interleaved: %s)",
	async (interleaved) => {
		const harness = await oauthHarness(false, "lazy");
		try {
			await harness.signIn();
			const previous = harness.store.read()?.authorization?.id;
			const client = harness.store.read()?.clientInfo?.client_id;
			const auth = resolveServerAuth({ config: harness.config, serverName: "race", agentDir: harness.dir });
			if (auth.provider === undefined) throw new Error("missing provider");
			await clientCredentialsGrant(auth.provider, {
				fetchFn: async (input, init) => {
					const response = await fetch(input, init);
					if (interleaved && String(input).endsWith("/token")) {
						await harness.signIn();
						expect(harness.store.read()?.clientInfo?.client_id).not.toBe(client);
					}
					return response;
				},
			});
			expect(harness.store.read()?.refreshToken).toBeUndefined();
			expect(harness.store.read()?.authorization?.id).not.toBe(previous);
			expect(harness.store.read()?.clientInfo?.client_id).toBe(client);
			expect(harness.store.read()?.resource).toBe(harness.config.url);
		} finally {
			await harness.cleanup();
		}
	},
);

it("uses opaque identity for unproven saves and establishes continuity only after a locked refresh", async () => {
	const harness = await oauthHarness(false, "lazy");
	try {
		await harness.signIn();
		const auth = resolveServerAuth({ config: harness.config, serverName: "race", agentDir: harness.dir });
		if (auth.provider === undefined || auth.refresh === undefined) throw new Error("missing refresh owner");
		const tokens = auth.provider.tokens();
		if (tokens === undefined) throw new Error("missing grant");
		const previous = harness.store.read()?.authorization?.id;
		await auth.provider.saveTokens({ ...tokens, scope: "mcp offline_access" });
		const unproven = harness.store.read()?.authorization?.id;
		expect(unproven).not.toBe(previous);
		expect(harness.store.read()?.authorization?.proof).toBeUndefined();
		expect(harness.store.read()?.refreshScope).toBeUndefined();
		await harness.expire();
		await auth.refresh.refresh();
		expect(harness.store.read()?.authorization?.id).not.toBe(unproven);
		expect(harness.store.read()?.authorization?.proof?.previousCredentialIdentity).toMatch(/^[0-9a-f]{64}$/);
		const identity = mcpCredentialIdentity(harness.config, "race", harness.dir, undefined);
		expect(legacyMcpCredentialIdentity(harness.config, "race", harness.dir, undefined)).toBeUndefined();
		await harness.expire();
		await auth.refresh.refresh();
		expect(mcpCredentialIdentity(harness.config, "race", harness.dir, undefined)).toBe(identity);
	} finally {
		await harness.cleanup();
	}
});

it.each(["rotated", "equal tokens", "equal binding and tokens"] as const)(
	"does not inherit another sign-in's refresh grant on a late SDK save (%s)",
	async (replacement) => {
		const harness = await oauthHarness(false, "lazy");
		try {
			await harness.signIn();
			const auth = resolveServerAuth({ config: harness.config, serverName: "race", agentDir: harness.dir });
			if (auth.provider === undefined) throw new Error("missing provider");
			const tokens = auth.provider.tokens();
			const previous = harness.store.read();
			const oldClient = previous?.clientInfo?.client_id;
			if (tokens === undefined) throw new Error("missing initial grant");
			await harness.signIn();
			expect(harness.store.read()?.clientInfo?.client_id).not.toBe(oldClient);
			// Equal credential bytes still cannot bridge a completed authorization epoch.
			if (replacement !== "rotated") {
				await harness.store.update((current) => ({
					...current,
					accessToken: previous?.accessToken,
					refreshToken: previous?.refreshToken,
					clientInfo: replacement === "equal tokens" ? current?.clientInfo : previous?.clientInfo,
				}));
			}
			await auth.provider.saveTokens({
				access_token: tokens.access_token,
				token_type: "Bearer",
				issuer: tokens.issuer,
				scope: tokens.scope,
			});
			expect(harness.store.read()?.clientInfo?.client_id).toBe(oldClient);
			expect(harness.store.read()?.refreshToken).toBeUndefined();
			expect(harness.store.read()?.authorization?.proof).toBeUndefined();
			expect(harness.store.read()?.refreshScope).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	},
);

it("keeps a fresh exchange's selected client and resource after a concurrent sign-in", async () => {
	const oauth = await oauthHarness(false, "lazy", [], "b");
	const resourceB = oauth.config.url;
	if (resourceB === undefined) throw new Error("missing resource B URL");
	const service = new McpService();
	const previous = process.env[ENV_AGENT_DIR];
	let agent: Awaited<ReturnType<typeof createHarness>> | undefined;
	const release = Promise.withResolvers<void>();
	let heldExchange: Promise<unknown> | undefined;
	try {
		const aUrl = new URL(oauth.fixture.mcpUrl);
		aUrl.searchParams.set("resource", "a");
		const providerB = new McpOAuthProvider({
			serverName: "race",
			serverUrl: resourceB,
			store: oauth.store,
			redirectUrl: "http://127.0.0.1:0/callback-b",
			requireRegisteredRedirect: true,
			scopes: ["mcp", "offline_access"],
		});
		const providerA = new McpOAuthProvider({
			serverName: "race",
			serverUrl: aUrl.href,
			store: oauth.store,
			redirectUrl: "http://127.0.0.1:0/callback-a",
			requireRegisteredRedirect: true,
			scopes: ["mcp", "offline_access"],
		});
		const authorize = async (provider: McpOAuthProvider): Promise<string> => {
			const started = await beginAuthorization(provider);
			if (started.authorizationUrl === undefined) throw new Error("fixture did not start authorization");
			const response = await fetch(started.authorizationUrl, { redirect: "manual" });
			const redirect = response.headers.get("location");
			if (redirect === null) throw new Error("fixture did not authorize");
			return redirect;
		};

		const redirectA = await authorize(providerA);
		const selectedA = providerA.clientInformation();
		if (selectedA === undefined) throw new Error("missing selected A client");
		const entered = Promise.withResolvers<void>();
		const exchangeA = completeAuthorization(providerA, redirectA, {
			fetchFn: async (input, init) => {
				if (new URL(String(input)).pathname === "/token") {
					entered.resolve();
					await release.promise;
				}
				return fetch(input, init);
			},
		});
		heldExchange = exchangeA;
		// Observe early rejection while B signs in; the approval path still awaits the original promise.
		void exchangeA.catch(() => {});
		await entered.promise;

		await oauth.store.update((record) => (record === undefined ? record : { ...record, discoveryState: undefined }));
		const redirectB = await authorize(providerB);
		await completeAuthorization(providerB, redirectB);
		const bGrant = oauth.store.read();
		if (bGrant?.clientInfo === undefined || bGrant.refreshToken === undefined || bGrant.authorization === undefined)
			throw new Error("missing B grant");
		expect(bGrant.clientInfo.client_id).not.toBe(selectedA.client_id);
		expect(bGrant.resource).toBe(oauth.config.url);

		process.env[ENV_AGENT_DIR] = oauth.dir;
		let approvals = 0;
		let completedA = false;
		agent = await createHarness({
			extensionFlagValues: new Map([["permission-preset", "ask"]]),
			extensionFactories: [permissionSystemExtension, createMcpExtension(service)],
		});
		await agent.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					expect(title).toContain("mcp_race_tool_1");
					expect(options).toContain("Allow once");
					approvals++;
					release.resolve();
					await exchangeA;
					completedA = true;
					return "Allow once";
				},
			}),
		});
		await agent.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
		expect(await service.whenAttachSettled(5000)).toBe("settled");
		const name = "mcp_race_tool_1";
		expect(agent.session.getAllTools().some((tool) => tool.name === name)).toBe(true);
		expect(agent.session.getActiveToolNames()).toContain(name);
		agent.setResponses([
			fauxAssistantMessage(fauxToolCall(name, { value: "stale" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await agent.session.prompt("call the fixture");
		expect(approvals).toBe(1);
		expect(completedA).toBe(true);

		const aGrant = oauth.store.read();
		expect(aGrant?.clientInfo?.client_id).toBe(selectedA.client_id);
		expect(aGrant?.resource).toBe(aUrl.href);
		expect(aGrant?.authorization?.id).not.toBe(bGrant.authorization.id);
		expect(aGrant?.refreshToken).not.toBe(bGrant.refreshToken);
		expect(getToolResult(agent, name)).toHaveProperty("details.error.kind", "unavailable");
		expect(
			(await oauth.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
		).toHaveLength(0);
	} finally {
		release.resolve();
		if (heldExchange !== undefined) await Promise.allSettled([heldExchange]);
		await service.dispose("quit");
		agent?.cleanup();
		if (previous === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previous;
		await oauth.cleanup();
	}
});

it("starts a new epoch for equal-byte fresh acquisition and clears omitted refresh credentials", async () => {
	const harness = await oauthHarness(false, "lazy");
	try {
		await harness.signIn();
		const owner = await harness.attach();
		const auth = resolveServerAuth({ config: harness.config, serverName: "race", agentDir: harness.dir });
		if (auth.provider === undefined) throw new Error("missing provider");
		const tokens = auth.provider.tokens();
		const epoch = harness.store.read()?.authorization?.id;
		if (tokens === undefined) throw new Error("missing grant");
		const provider = auth.provider;
		await provider.withFreshAuthorization(() =>
			provider.saveTokens({
				access_token: tokens.access_token,
				token_type: "Bearer",
				scope: tokens.scope,
				issuer: tokens.issuer,
			}),
		);
		expect(harness.store.read()?.accessToken).toBe(tokens.access_token);
		expect(harness.store.read()?.refreshToken).toBeUndefined();
		expect(harness.store.read()?.authorization?.id).not.toBe(epoch);
		expect(await owner.call("equal-byte-replacement")).toHaveProperty("details.error.kind", "unavailable");
		expect(
			(await harness.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
		).toHaveLength(0);
	} finally {
		await harness.cleanup();
	}
});

it("does not infer a legacy grant's scope when the refresh response omits it", async () => {
	const harness = await oauthHarness(false, "lazy", ["--omit-refresh-scope"]);
	try {
		await harness.signIn();
		await harness.store.update((record) => ({
			...record,
			authorization: undefined,
			scope: undefined,
			refreshScope: undefined,
		}));
		const auth = resolveServerAuth({ config: harness.config, serverName: "race", agentDir: harness.dir });
		if (auth.refresh === undefined) throw new Error("missing refresh");
		await harness.expire();
		await auth.refresh.refresh();
		const first = harness.store.read()?.authorization?.id;
		expect(harness.store.read()?.scope).toBeUndefined();
		expect(harness.store.read()?.authorization?.proof).toBeUndefined();
		await harness.expire();
		await auth.refresh.refresh();
		expect(harness.store.read()?.authorization?.id).not.toBe(first);
	} finally {
		await harness.cleanup();
	}
});

it("resolves omitted scope to the original grant after a narrowed access token", async () => {
	const harness = await oauthHarness(false, "lazy");
	try {
		await harness.signIn();
		const auth = resolveServerAuth({ config: harness.config, serverName: "race", agentDir: harness.dir });
		if (auth.provider === undefined) throw new Error("missing provider");
		let responses = 0;
		const refresh = new McpRefreshManager(auth.provider, {
			fetchFn: async (input, init) => {
				const response = await fetch(input, init);
				if (!String(input).endsWith("/token")) return response;
				const body: unknown = await response.json();
				if (typeof body !== "object" || body === null) throw new Error("invalid fixture token response");
				if (responses++ === 0) Reflect.set(body, "scope", "mcp");
				else Reflect.deleteProperty(body, "scope");
				return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
			},
		});
		await harness.expire();
		await refresh.refresh();
		const narrowed = harness.store.read();
		expect(narrowed?.scope).toBe("mcp");
		expect(narrowed?.refreshScope).toBe("mcp offline_access");
		await harness.expire();
		const tokens = await refresh.refresh();
		expect(tokens.scope).toBe("mcp offline_access");
		expect(harness.store.read()?.authorization?.id).not.toBe(narrowed?.authorization?.id);
	} finally {
		await harness.cleanup();
	}
});

it("authenticates without persisting ephemeral provenance when the installation key is invalid", async () => {
	const harness = await oauthHarness(false, "lazy");
	try {
		await writeFile(`${harness.dir}/config-identity.key`, "invalid", { mode: 0o600 });
		await harness.signIn();
		const owner = await harness.attach();
		expect(await owner.call("ephemeral")).not.toHaveProperty("details.error");
		expect(harness.store.read()?.authorization?.proof).toBeUndefined();
		expect(mcpCredentialIdentity(harness.config, "race", harness.dir, undefined)).toMatch(/^ephemeral:/);
		expect(
			(await harness.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
		).toHaveLength(1);
	} finally {
		await harness.cleanup();
	}
});
