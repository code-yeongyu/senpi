/**
 * Neo daemon auth-isolation proof (plan task 15 group e — a top-3 acceptance item).
 *
 * Two connections open on ONE daemon with DIFFERENT `--api-key` values. Each
 * connection's child worker is a real `senpi --mode rpc` process with its own
 * AuthStorage, so its outbound model request must carry ONLY its own key. We
 * assert this at a fake model server that records the auth header of every
 * request: request(s) from connection A carry key-A and never key-B, and vice
 * versa.
 *
 * This is the end-to-end complement to the deterministic supervisor tests in
 * neo-daemon-mode.test.ts. It spawns real children, so it is gated behind a
 * longer timeout and driven through the live TypeScript source via tsx (the
 * same path the senpi-qa mock-loop channel uses).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNeoChildWorkerFactory } from "../src/modes/rpc/neo-daemon-child-worker.ts";
import { type NeoDaemonHandle, runNeoDaemon } from "../src/modes/rpc/neo-daemon-mode.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
const TSX_ENTRY = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TSCONFIG = join(REPO_ROOT, "tsconfig.json");
const FAKE_SERVER_URL = new URL("../../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs", import.meta.url)
	.href;

const MODEL_ID = "mock-claude";
const TOKEN = "auth-iso-token";

interface FakeServer {
	origin: string;
	requests: Array<{ authorization: string | null; apiKeyHeader: string | null }>;
	stop: () => Promise<void>;
}

/** Typed dynamic loader for the JS fake-model-server (no .d.ts ships with it). */
async function startFakeModelServer(opts: { turns: Array<{ text?: string }> }): Promise<FakeServer> {
	const mod = (await import(FAKE_SERVER_URL)) as {
		startFakeModelServer: (o: { turns: Array<{ text?: string }> }) => Promise<FakeServer>;
	};
	return mod.startFakeModelServer(opts);
}

/** Provider env keys that could otherwise take precedence over the inline key. */
const PROVIDER_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY"];

function hermeticEnv(agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		SENPI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	for (const key of PROVIDER_ENV_KEYS) delete env[key];
	return env;
}

function writeMockModelsJson(agentDir: string, origin: string): void {
	const config = {
		providers: {
			anthropic: {
				baseUrl: origin,
				apiKey: "unused-placeholder",
				api: "anthropic-messages",
				models: [
					{
						id: MODEL_ID,
						baseUrl: origin,
						api: "anthropic-messages",
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(config, null, 2));
}

interface ClientConn {
	socket: Socket;
	next: () => Promise<Record<string, unknown>>;
	send: (obj: unknown) => void;
	end: () => void;
}

function openClient(listenPath: string): Promise<ClientConn> {
	return new Promise((resolve, reject) => {
		const socket = connect(listenPath);
		const queue: Record<string, unknown>[] = [];
		const waiters: Array<(m: Record<string, unknown>) => void> = [];
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.trim()) {
					const msg = JSON.parse(line);
					const w = waiters.shift();
					if (w) w(msg);
					else queue.push(msg);
				}
				nl = buffer.indexOf("\n");
			}
		});
		socket.on("connect", () =>
			resolve({
				socket,
				next: () =>
					new Promise((res) => {
						const queued = queue.shift();
						if (queued) res(queued);
						else waiters.push(res);
					}),
				send: (obj) => socket.write(`${JSON.stringify(obj)}\n`),
				end: () => socket.end(),
			}),
		);
		socket.on("error", reject);
	});
}

/** Wait until the client observes an event of the given type, or times out. */
async function waitForEvent(client: ClientConn, type: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const msg = await Promise.race([
			client.next(),
			new Promise<undefined>((r) => setTimeout(() => r(undefined), deadline - Date.now())),
		]);
		if (msg && msg.type === type) return;
	}
	throw new Error(`Timed out waiting for event '${type}'`);
}

describe("neo daemon per-connection auth isolation (e2e)", () => {
	let agentDir: string;
	let listenPath: string;
	let handle: NeoDaemonHandle | undefined;
	let server: FakeServer | undefined;
	const cwd = REPO_ROOT;

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "neo-auth-iso-"));
		listenPath = join(mkdtempSync(join(tmpdir(), "nai-")), "d.sock");
		server = await startFakeModelServer({ turns: [{ text: "OK" }, { text: "OK" }] });
		writeMockModelsJson(agentDir, server.origin);
	});

	afterEach(async () => {
		await handle?.shutdown();
		handle = undefined;
		await server?.stop();
		server = undefined;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("(e) two clients with different --api-key: each request carries only its own key", async () => {
		const keyA = "sk-ant-key-AAA-1111";
		const keyB = "sk-ant-key-BBB-2222";

		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			register: false,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: createNeoChildWorkerFactory({
				execPath: process.execPath,
				baseArgs: [TSX_ENTRY, "--tsconfig", TSCONFIG, CLI_ENTRY],
			}),
		});

		// Override the child env per spawn: point every child at the fake server's
		// agent dir and strip ambient provider keys. The child worker factory merges
		// process.env; we set it on the daemon process so both children inherit the
		// hermetic base, and each connection supplies its OWN --api-key.
		const savedEnv = { ...process.env };
		Object.assign(process.env, hermeticEnv(agentDir));

		try {
			const a = await openClient(listenPath);
			const b = await openClient(listenPath);
			a.send({
				type: "hello",
				token: TOKEN,
				version: 1,
				runtimeOptions: { provider: "anthropic", model: MODEL_ID, apiKey: keyA },
			});
			b.send({
				type: "hello",
				token: TOKEN,
				version: 1,
				runtimeOptions: { provider: "anthropic", model: MODEL_ID, apiKey: keyB },
			});
			expect(await a.next()).toMatchObject({ type: "welcome" });
			expect(await b.next()).toMatchObject({ type: "welcome" });

			a.send({ type: "prompt", id: "pa", message: "hello from A" });
			b.send({ type: "prompt", id: "pb", message: "hello from B" });

			// Wait until both turns complete so all requests have hit the server.
			await waitForEvent(a, "agent_end", 60000);
			await waitForEvent(b, "agent_end", 60000);

			const keys = (server?.requests ?? []).map((r) => r.apiKeyHeader ?? r.authorization);
			// Every request carried a mock key; both A and B keys are present.
			expect(keys).toContain(keyA);
			expect(keys).toContain(keyB);
			// Critically: no request mixed the two keys — the header set is exactly {A, B}.
			const distinct = new Set(keys.filter((k): k is string => k !== null));
			expect(distinct).toEqual(new Set([keyA, keyB]));

			a.end();
			b.end();
		} finally {
			// Restore env.
			for (const key of Object.keys(process.env)) {
				if (!(key in savedEnv)) delete process.env[key];
			}
			Object.assign(process.env, savedEnv);
		}
	}, 90000);
});
