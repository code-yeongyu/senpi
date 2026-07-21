import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";

describe("app-server account reads", () => {
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
