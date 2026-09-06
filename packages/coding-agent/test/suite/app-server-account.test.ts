import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitProviderAccountFailover } from "../../src/core/extensions/builtin/claude-sdk-oauth/account-events.ts";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";

describe("app-server account reads", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("projects Claude environment token slots from an empty isolated auth file", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "legacy-env");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN_2", "legacy-env-2");
		const fixture = await createFixture({});
		try {
			await initialize(fixture.core, fixture.connectionId);
			await fixture.core.receive(
				fixture.connectionId,
				request(2, "account/providerAccounts/read", { provider: "claude-sdk-oauth" }),
			);
			expect(resultOf(fixture.sent[1], 2)).toEqual({
				provider: "claude-sdk-oauth",
				accounts: [
					{ name: "env", source: "env", blocked: false, pinned: false },
					{ name: "env-2", source: "env", blocked: false, pinned: false },
				],
			});
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("does not project the Claude empty sentinel as a default account", async () => {
		const fixture = await createFixture({
			"claude-sdk-oauth": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4_102_444_800_000,
			},
		});
		try {
			await initialize(fixture.core, fixture.connectionId);
			await fixture.core.receive(
				fixture.connectionId,
				request(2, "account/providerAccounts/read", { provider: "claude-sdk-oauth" }),
			);
			expect(resultOf(fixture.sent[1], 2)).toEqual({ provider: "claude-sdk-oauth", accounts: [] });
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("projects Claude stored and environment accounts together", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "legacy-env");
		const fixture = await createFixture({
			"claude-sdk-oauth": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4_102_444_800_000,
				accounts: [{ name: "stored", source: "login", access: "a", refresh: "r", expires: 4_102_444_800_000 }],
			},
		});
		try {
			await initialize(fixture.core, fixture.connectionId);
			await fixture.core.receive(
				fixture.connectionId,
				request(2, "account/providerAccounts/read", { provider: "claude-sdk-oauth" }),
			);
			expect(resultOf(fixture.sent[1], 2)).toEqual({
				provider: "claude-sdk-oauth",
				accounts: [
					{ name: "stored", source: "login", blocked: false, pinned: false },
					{ name: "env", source: "env", blocked: false, pinned: false },
				],
			});
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("pins a Claude environment account and persists the compatible sentinel pin", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "legacy-env");
		const fixture = await createFixture({});
		try {
			await initialize(fixture.core, fixture.connectionId);
			await fixture.core.receive(
				fixture.connectionId,
				request(2, "account/providerAccounts/pin", { provider: "claude-sdk-oauth", name: "env" }),
			);
			expect(resultOf(fixture.sent[1], 2)).toEqual({});
			expect(
				JSON.parse(
					await (await import("node:fs/promises")).readFile(join(fixture.root, "agent", "auth.json"), "utf8"),
				)["claude-sdk-oauth"],
			).toMatchObject({
				pinned: "env",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
			});
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("reports an apiKey account when an isolated provider credential exists", async () => {
		// Given: an isolated auth fixture containing one provider credential.
		const fixture = await createFixture({
			"fixture-provider": { type: "api_key", key: "fixture-key" },
		});

		try {
			await initialize(fixture.core, fixture.connectionId);

			// When: account/read is requested with the refresh flag.
			await fixture.core.receive(fixture.connectionId, request(2, "account/read", { refreshToken: true }));

			// Then: the stored credential is represented only as an API-key account.
			expect(resultOf(fixture.sent[1], 2)).toEqual({
				account: { type: "apiKey" },
				requiresOpenaiAuth: false,
			});
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("reads, pins, and removes provider accounts without exposing credentials", async () => {
		// Given: managed provider slots include token-shaped values that must stay in auth.json.
		const fixture = await createFixture({
			"claude-sdk-oauth": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4_102_444_800_000,
				pinned: "work",
				accounts: [
					{
						name: "personal",
						source: "login",
						access: "sk-ant-test-personal",
						refresh: "refresh-personal",
						expires: 4_102_444_800_000,
					},
					{
						name: "work",
						source: "import",
						access: "sk-ant-test-work",
						refresh: "refresh-work",
						expires: 4_102_444_800_000,
						blockReason: "rate_limit",
						blockedUntil: 4_102_444_800_000,
					},
				],
			},
		});

		try {
			await initialize(fixture.core, fixture.connectionId);

			// When: the desktop-facing provider account methods are used.
			await fixture.core.receive(
				fixture.connectionId,
				request(2, "account/providerAccounts/read", { provider: "claude-sdk-oauth" }),
			);
			await fixture.core.receive(
				fixture.connectionId,
				request(3, "account/providerAccounts/pin", { provider: "claude-sdk-oauth", name: "personal" }),
			);
			await fixture.core.receive(
				fixture.connectionId,
				request(4, "account/providerAccounts/remove", { provider: "claude-sdk-oauth", name: "work" }),
			);

			// Then: only safe slot metadata crosses the wire and each mutation notifies clients.
			expect(resultOf(fixture.sent[1], 2)).toEqual({
				provider: "claude-sdk-oauth",
				accounts: [
					{ name: "personal", source: "login", blocked: false, pinned: false },
					{ name: "work", source: "import", blocked: true, pinned: true },
				],
			});
			expect(resultOf(fixture.sent[2], 3)).toEqual({});
			expect(resultOf(fixture.sent[4], 4)).toEqual({});
			emitProviderAccountFailover("claude-sdk-oauth", "personal", "work", "rate_limit");
			const notifications = fixture.sent.filter(
				(message) => "method" in message && message.method === "account/providerAccounts/updated",
			);
			expect(notifications).toHaveLength(2);
			for (const notification of notifications) {
				expect(notification).toMatchObject({ params: { provider: "claude-sdk-oauth" } });
			}
			expect(fixture.sent.at(-1)).toMatchObject({
				method: "account/providerAccounts/failover",
				params: { provider: "claude-sdk-oauth", from: "personal", to: "work", reason: "rate_limit" },
			});
			expect(JSON.stringify(fixture.sent)).not.toMatch(/sk-ant/);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("reports no account when the isolated auth fixture is empty", async () => {
		// Given: an isolated auth fixture with no provider credentials.
		const fixture = await createFixture({});

		try {
			await initialize(fixture.core, fixture.connectionId);

			// When: account/read is requested without parameters.
			await fixture.core.receive(fixture.connectionId, request(2, "account/read", undefined));

			// Then: no account is fabricated and managed auth is not required.
			expect(resultOf(fixture.sent[1], 2)).toEqual({ account: null, requiresOpenaiAuth: false });
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects rate-limit and usage reads with Codex unauthenticated errors", async () => {
		// Given: an isolated auth fixture with no Codex account.
		const fixture = await createFixture({});

		try {
			await initialize(fixture.core, fixture.connectionId);

			// When: the account-backed reads are requested.
			await fixture.core.receive(fixture.connectionId, request(2, "account/rateLimits/read", undefined));
			await fixture.core.receive(fixture.connectionId, request(3, "account/usage/read", undefined));

			// Then: both paths return the pinned invalid-request category and message.
			expect(errorOf(fixture.sent[1], 2)).toEqual({
				code: -32600,
				message: "codex account authentication required to read rate limits",
			});
			expect(errorOf(fixture.sent[2], 3)).toEqual({
				code: -32600,
				message: "codex account authentication required to read token usage",
			});
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});
});

type Fixture = {
	readonly root: string;
	readonly core: ServerCore;
	readonly connectionId: string;
	readonly sent: RpcEnvelope[];
};

async function createFixture(authData: Record<string, unknown>): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "senpi-app-server-account-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "auth.json"), JSON.stringify(authData));

	const sent: RpcEnvelope[] = [];
	const core = new ServerCore({ codexHome: agentDir, serverCwd: root, version: "2026.7.2" });
	const connection = core.addConnection({
		id: "account-test",
		transportKind: "stdio",
		send: (message) => {
			sent.push(message);
		},
		close: () => undefined,
	});
	return { root, core, connectionId: connection.id, sent };
}

async function initialize(core: ServerCore, connectionId: string): Promise<void> {
	await core.receive(
		connectionId,
		request(1, "initialize", {
			clientInfo: { name: "account-test", title: "Account Test", version: "0.0.1" },
			capabilities: { experimentalApi: false, requestAttestation: false },
		}),
	);
}

function request(
	id: number,
	method: string,
	params: unknown,
): {
	readonly kind: "request";
	readonly message: { readonly id: number; readonly method: string; readonly params: unknown };
} {
	return { kind: "request", message: { id, method, params } };
}

function resultOf(message: RpcEnvelope | undefined, id: number): unknown {
	expect(message).toEqual({ id, result: expect.anything() });
	if (message !== undefined && "result" in message && message.id === id) return message.result;
	throw new Error(`request ${id} did not return a result`);
}

function errorOf(message: RpcEnvelope | undefined, id: number): unknown {
	expect(message).toEqual({ id, error: expect.anything() });
	if (message !== undefined && "error" in message && message.id === id) return message.error;
	throw new Error(`request ${id} did not return an error`);
}
