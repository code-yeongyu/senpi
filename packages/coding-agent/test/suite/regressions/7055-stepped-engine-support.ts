/**
 * senpi#7055: a supervisor in front of an engine whose event loop is busy. The engine does nothing on its own: every
 * connection it accepts and every record it routes waits in one queue until the test runs it with `step()`, so "how many
 * engine turns does a client's handshake need" is a count of explicit steps, never a measured time. The supervisor's
 * timers (spare refill, challenge budget) are injected too and fire only when the test fires them.
 */
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { HostAdmission } from "../../../src/modes/rpc/host-admission.ts";
import { ClientOccupancy } from "../../../src/modes/rpc/host-client-occupancy.ts";
import { createPublicProxy, listen } from "../../../src/modes/rpc/host-lifecycle-proxy.ts";
import { acceptInternalConnection } from "../../../src/modes/rpc/internal-channel.ts";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import { connectAuthenticatedRpcSocket } from "../../../src/modes/rpc/rpc-auth-client.ts";
import type { Schedule } from "../../../src/modes/rpc/socket-transport.ts";
import { RpcPublicEndpoint } from "../../../src/modes/rpc/rpc-public-key.ts";

export type Step =
	| { readonly kind: "accept"; readonly conn: number }
	| { readonly kind: "record"; readonly conn: number; readonly type: unknown; readonly id: unknown };

export type Wire = Readonly<Record<string, unknown>>;

export class SteppedEngine {
	readonly occupancy = new ClientOccupancy(() => {});
	readonly closed = new Set<number>();
	readonly refusedHops: string[] = [];
	readonly history: Step[] = [];
	readonly server: Server;
	private readonly queue: { readonly step: Step; readonly run: () => Promise<void> | void }[] = [];
	private readonly sockets = new Set<Socket>();
	private readonly waiters = new Set<() => void>();
	private connections = 0;

	constructor(key: Buffer) {
		this.server = createServer((socket) => {
			const conn = ++this.connections;
			this.sockets.add(socket);
			socket.on("error", () => {});
			socket.once("close", () => {
				this.closed.add(conn);
				this.notify();
			});
			this.enqueue({ kind: "accept", conn }, async () => {
				let hop: Duplex;
				try {
					hop = await acceptInternalConnection(socket, key, { protocolVersion: 1, serverVersion: "fixture" });
				} catch (cause) {
					this.refusedHops.push(cause instanceof Error ? cause.message : String(cause));
					return;
				}
				this.occupancy.admit(hop);
				const capabilities: string[] = [];
				attachJsonlLineReader(hop, (line) => {
					const record: Wire = JSON.parse(line);
					this.enqueue({ kind: "record", conn, type: record.type, id: record.id }, () => {
						if (record.type === "launch_proven") return;
						if (record.type === "set_caps" && Array.isArray(record.caps)) capabilities.splice(0, Infinity, ...record.caps);
						const data =
							record.type === "get_protocol_info"
								? { protocolVersion: 1, serverVersion: "fixture", capabilities: [...capabilities], connection: conn }
								: {};
						hop.write(`${JSON.stringify({ id: record.id, type: "response", command: record.type, success: true, data })}\n`);
					});
				});
			});
		});
	}

	async next(): Promise<Step> {
		while (this.queue.length === 0) await this.changed();
		return this.queue[0].step;
	}

	async step(): Promise<Step> {
		await this.next();
		const head = this.queue.shift();
		if (!head) throw new Error("unreachable: next() returned with an empty queue");
		await head.run();
		return head.step;
	}

	async whenClosed(conn: number): Promise<void> {
		while (!this.closed.has(conn)) await this.changed();
	}

	destroy(): void {
		for (const socket of this.sockets) socket.destroy();
	}

	private enqueue(step: Step, run: () => Promise<void> | void): void {
		this.history.push(step);
		this.queue.push({ step, run });
		this.notify();
	}

	private changed(): Promise<void> {
		return new Promise((resolve) => this.waiters.add(resolve));
	}

	private notify(): void {
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const wake of waiters) wake();
	}
}

export class ManualTimers {
	readonly armed: { readonly ms: number; readonly fire: () => void; cancelled: boolean }[] = [];
	private readonly waiters = new Set<() => void>();
	readonly schedule: Schedule = (ms, fire) => {
		const timer = { ms, fire, cancelled: false };
		this.armed.push(timer);
		for (const wake of this.waiters) wake();
		this.waiters.clear();
		return () => {
			timer.cancelled = true;
		};
	};

	async whenArmed(ms: number): Promise<void> {
		while (!this.pending().includes(ms)) await new Promise<void>((resolve) => this.waiters.add(resolve));
	}

	pending(): number[] {
		return this.armed.filter((timer) => !timer.cancelled).map((timer) => timer.ms);
	}

	fire(ms: number): void {
		const timer = this.armed.find((candidate) => !candidate.cancelled && candidate.ms === ms);
		if (!timer) throw new Error(`no armed ${ms} ms timer; armed: ${JSON.stringify(this.pending())}`);
		timer.cancelled = true;
		timer.fire();
	}
}

export async function steppedSupervisor(options: { readonly engineKey?: Buffer } = {}) {
	const root = await mkdtemp(join(tmpdir(), "s7055-"));
	const agentDir = join(root, "a");
	await mkdir(agentDir, { mode: 0o700 });
	const key = Buffer.alloc(32, 9);
	const engine = new SteppedEngine(options.engineKey ?? key);
	const enginePath = join(root, "e.sock");
	const publicPath = join(root, "p.sock");
	await listen(engine.server, enginePath);
	const endpoint = new RpcPublicEndpoint(agentDir, publicPath);
	const timers = new ManualTimers();
	const clients = new ClientOccupancy(() => {});
	const server = createPublicProxy({
		internalSocket: enginePath,
		internalKey: key,
		publicEndpoint: endpoint,
		clients,
		admission: new HostAdmission({ protocolVersion: 1, serverVersion: "fixture", capabilities: [], instanceId: "s" }),
		onDetach: () => {},
		spareHop: true,
		timers: timers.schedule,
	});
	await listen(server, publicPath);
	await endpoint.publish();
	return {
		engine,
		timers,
		clients,
		agentDir,
		publicPath,
		async dispose() {
			clients.destroyAll();
			engine.destroy();
			server.close();
			engine.server.close();
			await Promise.all([once(server, "close"), once(engine.server, "close")]).catch(() => {});
			await endpoint.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** Runs engine turns until `done` settles; returns the turns it ran. */
export async function stepUntil(engine: SteppedEngine, done: Promise<unknown>): Promise<Step[]> {
	const settled = done.then(
		() => "done" as const,
		() => "done" as const,
	);
	const ran: Step[] = [];
	while ((await Promise.race([engine.next().then(() => "step" as const), settled])) === "step") ran.push(await engine.step());
	return ran;
}

/** Runs engine turns until one matching `wanted` has run. */
export async function stepThrough(engine: SteppedEngine, wanted: (step: Step) => boolean): Promise<Step[]> {
	const ran: Step[] = [];
	for (;;) {
		const step = await engine.step();
		ran.push(step);
		if (wanted(step)) return ran;
	}
}

export type SteppedSupervisor = Awaited<ReturnType<typeof steppedSupervisor>>;

/** A client authenticated through the shipped client, its protocol answer, and the engine turns that took. */
export async function authenticatedClient(s: SteppedSupervisor) {
	const connecting = connectAuthenticatedRpcSocket(s.publicPath, undefined, { keyRoot: s.agentDir }, 60_000);
	const turns = await stepUntil(s.engine, connecting);
	const { socket, protocol } = await connecting;
	const replies = new Map<unknown, (reply: Wire) => void>();
	attachJsonlLineReader(socket, (line) => {
		const reply: Wire = JSON.parse(line);
		replies.get(reply.id)?.(reply);
	});
	const ask = async (record: Wire): Promise<Wire> => {
		const answered = new Promise<Wire>((resolve) => replies.set(record.id, resolve));
		socket.write(`${JSON.stringify(record)}\n`);
		await stepUntil(s.engine, answered);
		return answered;
	};
	return { socket, data: protocol.data as Wire, turns, ask };
}

/** Fires the supervisor's armed refill and runs the engine turns that open the spare as connection `conn`. */
export async function openSpare(s: SteppedSupervisor, conn: number): Promise<void> {
	const armed = s.timers.pending();
	if (armed.length !== 1 || armed[0] !== 0) throw new Error(`expected one armed refill, armed: ${JSON.stringify(armed)}`);
	s.timers.fire(0);
	await stepThrough(s.engine, (step) => step.kind === "record" && step.conn === conn && step.type === "get_protocol_info");
}
