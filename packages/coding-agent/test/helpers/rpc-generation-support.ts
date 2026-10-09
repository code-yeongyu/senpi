/**
 * Rig for the generation-handoff suite: real supervisors, real hosts, one public socket.
 *
 * Every helper here drives the PRODUCTION lifecycle entry (`src/modes/rpc/host-lifecycle.ts`)
 * through the same launch seam `ensureHost`/`handoffHost` use, so a case observes what a
 * client would observe over the socket - never an in-process stand-in for it.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../../src/modes/rpc/socket-transport.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER } from "./rpc-hermetic.ts";

export { processAlive, reapProcessesUnder, waitForPidGone } from "./spawned-host-reaper.ts";

export type WireRecord = Record<string, unknown>;

export interface GenerationScratch {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly cwd: string;
	readonly socket: string;
}

/** Short prefix on purpose: `<socket>.next-<gen>` must stay inside the 104-byte sun_path limit. */
export function generationScratch(label: string): GenerationScratch {
	const root = mkdtempSync(join(tmpdir(), `sg-${label}-`));
	const scratch = {
		root,
		agentDir: join(root, "a"),
		sessionDir: join(root, "s"),
		cwd: join(root, "w"),
		socket: join(root, "rpc.sock"),
	};
	for (const dir of [scratch.agentDir, scratch.sessionDir, scratch.cwd]) mkdirSync(dir, { recursive: true });
	return scratch;
}

export function hostLifecycleEntry(): string {
	return join(import.meta.dirname, "..", "..", "src", "modes", "rpc", "host-lifecycle.ts");
}

/** The launch seam both ensure and handoff take: supervisor argv in, spawnable command out. */
export function supervisorLaunch(args: readonly string[]): { command: string; args: string[] } {
	return { command: process.execPath, args: [hostLifecycleEntry(), ...args] };
}

export const GENERATION_HOST_ARGS = ["--provider", MOCK_PROVIDER, "--model", MOCK_MODEL] as const;

export function generationEnv(qa: GenerationScratch): Record<string, string> {
	return {
		...hermeticProviderEnv(),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		SENPI_RUNTIME: "node",
		SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
	};
}

export async function socketInode(socketPath: string): Promise<number | undefined> {
	try {
		return (await stat(socketPath)).ino;
	} catch {
		return undefined;
	}
}

export function openedSessionId(response: WireRecord): string {
	const data = response.data as WireRecord | undefined;
	if (typeof data?.sessionId !== "string") {
		throw new Error(`open_session had no session id: ${JSON.stringify(response)}`);
	}
	return data.sessionId;
}

/** One JSONL client connection, with request/response correlation and record waiting. */
export class JsonlPeer {
	readonly messages: WireRecord[] = [];
	closed = false;
	private buffer = "";
	private readonly socket: Socket;
	private readonly waiters = new Set<{
		predicate: (value: WireRecord) => boolean;
		resolve: (value: WireRecord) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private readonly closeWaiters = new Set<() => void>();

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk) => this.read(chunk.toString("utf8")));
		socket.once("close", () => {
			this.closed = true;
			for (const resolve of [...this.closeWaiters]) resolve();
			this.closeWaiters.clear();
		});
	}

	static async connect(socketPath: string): Promise<JsonlPeer> {
		const secret = process.platform === "win32" ? await readSocketSecret(socketSecretPath(socketPath)) : undefined;
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		if (secret) sendSocketHandshake(socket, secret);
		return new JsonlPeer(socket);
	}

	/** Send a command whose answer may be the host closing this connection. */
	send(command: WireRecord): void {
		this.socket.write(`${JSON.stringify(command)}\n`);
	}

	request(command: WireRecord, timeoutMs = 20_000): Promise<WireRecord> {
		const response = this.waitFor((value) => value.type === "response" && value.id === command.id, timeoutMs);
		this.socket.write(`${JSON.stringify(command)}\n`);
		return response;
	}

	waitFor(predicate: (value: WireRecord) => boolean, timeoutMs = 20_000): Promise<WireRecord> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error(`timed out waiting for an RPC record (${this.messages.length} seen)`));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	/** Resolves when the host closes this connection - the observable end of a generation. */
	waitForClose(timeoutMs = 60_000): Promise<void> {
		if (this.closed) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("connection stayed open")), timeoutMs);
			this.closeWaiters.add(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	destroy(): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve({ type: "peer-destroyed" });
		}
		this.waiters.clear();
		this.socket.destroy();
	}

	private read(text: string): void {
		this.buffer += text;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line) as WireRecord;
			this.messages.push(message);
			for (const waiter of [...this.waiters]) {
				if (!waiter.predicate(message)) continue;
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
	}
}

/** Anthropic-Messages fake whose single answer is withheld until release(), holding a turn open. */
export class HeldAnthropicModel {
	private readonly server: Server;
	private readonly releaseHolds: () => void;

	private constructor(server: Server, releaseHolds: () => void) {
		this.server = server;
		this.releaseHolds = releaseHolds;
	}

	static async start(): Promise<HeldAnthropicModel> {
		let releaseHolds: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			releaseHolds = resolve;
		});
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => void held.then(() => writeHeldAnswer(res)));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return new HeldAnthropicModel(server, releaseHolds);
	}

	get origin(): string {
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	release(): void {
		this.releaseHolds();
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}
}

function writeHeldAnswer(res: ServerResponse): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const send = (event: string, data: Record<string, unknown>): void => {
		res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	};
	send("message_start", {
		message: {
			id: "msg-held-generation",
			type: "message",
			role: "assistant",
			model: MOCK_MODEL,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	});
	send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "held turn complete" } });
	send("content_block_stop", { index: 0 });
	send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
	send("message_stop", {});
	res.end();
}
