/**
 * The delegated-connection host fixture (senpi#5632, omo-relay-daemon#307): records travel over a real Unix socket
 * through the bare host's public-key filter (`PublicRpcConnection`) into the per-connection dispatch `createHostCore`
 * builds, with the production socket wiring (`registerConnection` with the in-band proof, `unregisterConnection` and
 * `releaseConnection` on close). `workers: true` runs every session in a real `node:worker_threads` isolate; its
 * provider and `/block` command come from a file-backed `--extension`, because an inline factory cannot cross the isolate.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { connectAuthenticatedRpcSocket } from "../../src/modes/rpc/rpc-auth-client.ts";
import { PublicRpcConnection } from "../../src/modes/rpc/rpc-public-auth.ts";
import { RpcPublicEndpoint } from "../../src/modes/rpc/rpc-public-key.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";
import { ANSWER_DEADLINE_MS, Peer, type WireRecord } from "./rpc-delegated-peer.ts";
import { waitForFifoReader } from "./rpc-worker-host-support.ts";

export { ANSWER_DEADLINE_MS, Peer, type WireRecord };

export const PRINCIPAL = { deviceId: "x5632-device" };
export const LEAN_ARGS = ["--mode", "rpc", "--multi-session", "--no-extensions", "--no-skills", "--no-context-files"];
export const SECRET_COMMAND = "x5632-secret";
/** A non-secret dialog the peer's own command raises, so its `remoteOrigin` can be read (omo-relay-daemon#307 O1). */
export const ASK_COMMAND = "x307-ask";

/** The worker-side extension: a provider the isolate can open sessions with, and `/block` reading `fifo`. */
function workerExtension(fifo: string): string {
	return `import { readFileSync } from "node:fs";
export default function (pi) {
	pi.registerProvider("x307-faux", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "x307",
		api: "openai-completions",
		models: [{ id: "faux-1", name: "faux-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
	});
	pi.registerCommand("block", { description: "blocks the session thread on a FIFO", handler: async () => {
		readFileSync(${JSON.stringify(fifo)});
	} });
}
`;
}

export async function startHost(options: { readonly workers?: boolean } = {}) {
	const scratch = await mkdtemp(join(tmpdir(), "x5632-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir, { mode: 0o700 });
	for (const name of ["SENPI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) vi.stubEnv(name, agentDir);
	vi.stubEnv("SENPI_RPC_KEY_ROOT", agentDir);
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false, contextWindow: 128_000 }] });
	const fifo = join(scratch, "block.fifo");
	const extension = join(scratch, "gates.mjs");
	if (options.workers) {
		execFileSync("mkfifo", [fifo]);
		await writeFile(extension, workerExtension(fifo));
	}
	const configuration = {
		parsed: parseArgs(options.workers ? [...LEAN_ARGS, "--extension", extension] : LEAN_ARGS),
		cwd,
		agentDir,
		appMode: "rpc" as const,
	};
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore(
		{
			agentDir,
			cwd,
			permissionPreset: "full-access",
			createRuntime: createCliRuntimeFactory(configuration, {
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
						pi.registerCommand(SECRET_COMMAND, {
							description: "asks for a secret",
							handler: async (_args, ctx) => {
								await ctx.ui.input("Key", undefined, { secret: true });
							},
						});
						pi.registerCommand(ASK_COMMAND, {
							description: "asks a question",
							handler: async (_args, ctx) => {
								await ctx.ui.input("Question");
							},
						});
					},
				],
			}),
			...(options.workers ? { workerConfiguration: configuration } : {}),
			creationModel: { provider: options.workers ? "x307-faux" : faux.getModel().provider, modelId: "faux-1" },
		},
		writer,
		[],
	);
	const socketPath = join(scratch, "s");
	const endpoint = new RpcPublicEndpoint(agentDir, socketPath);
	await endpoint.publish();
	const sockets = new Set<Socket>();
	let connections = 0;
	let accepted = "";
	// The bare host's wiring: the public-key filter in front of the per-connection dispatch, the connection
	// registered with the proof the filter delivers in band, and the socket host's own close path.
	const server: Server = createServer((raw) => {
		sockets.add(raw);
		const id = `socket-${++connections}`;
		accepted = id;
		const stream = new PublicRpcConnection(raw, endpoint, false).stream;
		stream.on("error", () => {});
		writer.registerConnection(id, socketSink(stream), { launchProof: "in_band" });
		raw.once("close", () => {
			sockets.delete(raw);
			writer.unregisterConnection(id);
			void core.router.releaseConnection(id).catch(() => {});
		});
		attachJsonlLineReader(stream, (line) => void writer.withConnection(id, () => core.handle(line)));
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	let peers = 0;
	return {
		scratch,
		cwd,
		writer,
		core,
		fifo,
		async proven(): Promise<Peer> {
			const { socket } = await connectAuthenticatedRpcSocket(socketPath, undefined, { keyRoot: agentDir });
			// The authenticated connect resolves only after the server accepted, and peers are created one at a time.
			return new Peer(socket, `p${++peers}`, accepted);
		},
		async keyless(): Promise<Peer> {
			const socket = connect(socketPath);
			await new Promise<void>((resolve) => socket.once("connect", resolve));
			const peer = new Peer(socket, `k${++peers}`);
			expect(await peer.send({ type: "get_protocol_info" })).toMatchObject({ success: true });
			return peer;
		},
		/** Resolves once the worker thread is blocked inside `/block`; `release` lets it continue. */
		async blocked(): Promise<{ release(): Promise<void> }> {
			const gate = await waitForFifoReader(fifo);
			return {
				async release() {
					await gate.write("\n");
					await gate.close();
				},
			};
		},
		async dispose(): Promise<void> {
			await core.router.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await endpoint.dispose();
			await rm(scratch, { recursive: true, force: true });
			vi.unstubAllEnvs();
		},
	};
}

export type DelegatedHost = Awaited<ReturnType<typeof startHost>>;

export interface OpenedSession {
	readonly sessionId: string;
	readonly durableSessionId: string;
}

/** Opens a session through `opener`; `attach` gives the `attach_session` record for it (identity included). */
export async function openSession(opener: Peer, extra: WireRecord = {}): Promise<OpenedSession> {
	const answer = await opener.send({ type: "open_session", ...extra });
	const data = answer.data as { sessionId: string; state: { sessionId: string } };
	return { sessionId: data.sessionId, durableSessionId: data.state.sessionId };
}

export function attach(session: OpenedSession): WireRecord {
	return { type: "attach_session", sessionId: session.sessionId, durableSessionId: session.durableSessionId };
}

export async function declare(
	peer: Peer,
	granted: readonly string[],
	principal: object = PRINCIPAL,
	extra: WireRecord = {},
) {
	return peer.send({ type: "declare_delegation", principal, granted, ...extra });
}

/**
 * Waits until the authority word at `index` satisfies `predicate` (omo-relay-daemon#307, v5 §7.1): success at once when
 * it already holds; otherwise compare-and-wait against the CURRENT value, re-checking after every wake, under one
 * bounded deadline. A ref'd timer holds the deadline, since a pending `Atomics.waitAsync` alone does not keep Node alive.
 */
export async function awaitWord(
	view: Int32Array,
	index: number,
	predicate: (word: number) => boolean,
	deadlineMs = ANSWER_DEADLINE_MS,
): Promise<number> {
	const end = performance.now() + deadlineMs;
	for (;;) {
		const current = Atomics.load(view, index);
		if (predicate(current)) return current;
		const left = end - performance.now();
		if (left <= 0) throw new Error(`authority word ${current} did not reach the expected state`);
		const wait = Atomics.waitAsync(view, index, current, left);
		if (!wait.async) continue;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			wait.value,
			new Promise<void>((done) => {
				timer = setTimeout(done, left + 1);
			}),
		]);
		clearTimeout(timer);
	}
}
