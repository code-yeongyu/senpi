import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcEnvelope } from "../../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";

const root = await mkdtemp(join(tmpdir(), "senpi-task21-account-"));
const credentialAgentDir = join(root, "credential-agent");
const emptyAgentDir = join(root, "empty-agent");
await mkdir(credentialAgentDir, { recursive: true });
await mkdir(emptyAgentDir, { recursive: true });
await writeFile(
	join(credentialAgentDir, "auth.json"),
	JSON.stringify({ "fixture-provider": { type: "api_key", key: "fixture-key" } }),
);
await writeFile(join(emptyAgentDir, "auth.json"), "{}");

const credentialRun = createRun("task21-credential", credentialAgentDir);
const emptyRun = createRun("task21-empty", emptyAgentDir);

try {
	await initialize(credentialRun);
	await initialize(emptyRun);
	await credentialRun.core.receive(credentialRun.connectionId, request(2, "account/read", { refreshToken: true }));
	await emptyRun.core.receive(emptyRun.connectionId, request(2, "account/read", undefined));
	await emptyRun.core.receive(emptyRun.connectionId, request(3, "account/rateLimits/read", undefined));
	await emptyRun.core.receive(emptyRun.connectionId, request(4, "account/usage/read", undefined));

	const accountApiKey = deepEqual(resultOf(credentialRun.sent[1], 2), {
		account: { type: "apiKey" },
		requiresOpenaiAuth: false,
	});
	const accountNull = deepEqual(resultOf(emptyRun.sent[1], 2), {
		account: null,
		requiresOpenaiAuth: false,
	});
	const rateLimitsError = deepEqual(errorOf(emptyRun.sent[2], 3), {
		code: -32600,
		message: "codex account authentication required to read rate limits",
	});
	const usageError = deepEqual(errorOf(emptyRun.sent[3], 4), {
		code: -32600,
		message: "codex account authentication required to read token usage",
	});

	console.log(`ACCOUNT_APIKEY=${accountApiKey ? 1 : 0}`);
	console.log(`ACCOUNT_NULL=${accountNull ? 1 : 0}`);
	console.log(`RATELIMITS_ERROR=${rateLimitsError ? 1 : 0}`);
	console.log(`USAGE_ERROR=${usageError ? 1 : 0}`);
	console.log("EXIT=0");
	if (!accountApiKey || !accountNull || !rateLimitsError || !usageError) {
		throw new Error("task21 account assertions failed");
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

type Run = {
	readonly core: ServerCore;
	readonly connectionId: string;
	readonly sent: RpcEnvelope[];
};

function createRun(id: string, agentDir: string): Run {
	const sent: RpcEnvelope[] = [];
	const core = new ServerCore({ codexHome: agentDir, serverCwd: root, version: "2026.7.2" });
	const connection = core.addConnection({
		id,
		transportKind: "stdio",
		send: (message) => {
			sent.push(message);
		},
		close: () => undefined,
	});
	return { core, connectionId: connection.id, sent };
}

async function initialize(run: Run): Promise<void> {
	await run.core.receive(
		run.connectionId,
		request(1, "initialize", {
			clientInfo: { name: "task21", title: "Task 21", version: "0.0.1" },
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
	if (message !== undefined && "result" in message && message.id === id) return message.result;
	throw new Error(`request ${id} did not return a result`);
}

function errorOf(message: RpcEnvelope | undefined, id: number): unknown {
	if (message !== undefined && "error" in message && message.id === id) return message.error;
	throw new Error(`request ${id} did not return an error`);
}

function deepEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
