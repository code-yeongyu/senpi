/**
 * Neo daemon mode: a JSONL-over-socket server that serves N neo clients sharing
 * one cwd, each with its own runtime.
 *
 * ISOLATION MODEL (see task-15 spike, evidence/task-15-neo-go-tui.md §1):
 * running N `createAgentSessionRuntime` instances concurrently in a SINGLE node
 * process is NOT safe — pi-ai's process-global provider registry
 * (`resetApiProviders`) and pi-agent-core's module-level UUIDv7 counter cause
 * cross-talk, and both are out of scope to change. The daemon therefore uses the
 * plan's documented contingency: the daemon process is a SUPERVISOR that runs
 * ONE worker (its own child process) per connection. Each worker is a standard,
 * already-proven single-connection `runRpcMode` runtime with its own module
 * state and its own AuthStorage, so a connection's `--api-key` can never leak
 * into another connection. Concurrency is real (separate processes).
 *
 * The worker factory is injectable so tests can drive the supervisor
 * deterministically (handshake, registry, idle) without spawning real children,
 * while production spawns `node <cli> --mode rpc` per connection.
 *
 * REGISTRY/RACE: the daemon binds the socket FIRST (bind is the mutex — the race
 * loser gets EADDRINUSE and the client attaches to the winner), THEN atomically
 * self-registers as the LAST listen step. Clients never write the registry.
 *
 * CONNECTION LIFECYCLE: a socket disconnect aborts that connection's in-flight
 * turn and disposes its worker; sessions persist incrementally to disk so
 * recovery is resume-from-file. Idle shutdown fires after a configurable
 * no-connection period.
 */

import { createServer, type Server, type Socket } from "node:net";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import {
	type NeoDaemonHandshakeReply,
	type NeoHelloMessage,
	parseHello,
	validateHello,
} from "./neo-daemon-protocol.ts";
import {
	cleanupStaleNeoDaemon,
	NEO_DAEMON_PROTOCOL_VERSION,
	type NeoDaemonRecord,
	removeNeoDaemonRecord,
	writeNeoDaemonRecord,
} from "./neo-daemon-registry.ts";
import type { NeoRuntimeOptions } from "./neo-runtime-options.ts";

/** A live worker serving exactly one connection. */
export interface NeoDaemonWorker {
	/** Feed one inbound JSONL line from the client to the worker. */
	handleLine(line: string): void;
	/** Called when the connection drops; abort the in-flight turn and dispose. */
	dispose(): Promise<void>;
}

/**
 * Build a worker for one accepted connection. `writeToClient` sends a
 * (LF-terminated) JSONL line back to the client. `runtimeOptions` are the
 * per-connection options from the handshake. `signal` aborts when the
 * connection drops or the daemon shuts down.
 */
export type NeoDaemonWorkerFactory = (args: {
	readonly runtimeOptions: NeoRuntimeOptions;
	readonly capabilities: readonly string[];
	readonly cwd: string;
	readonly agentDir: string;
	readonly writeToClient: (line: string) => void;
	readonly signal: AbortSignal;
}) => Promise<NeoDaemonWorker>;

/** Minimal injectable clock so idle-shutdown timing is testable. */
export interface NeoDaemonClock {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: NeoDaemonClock = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface NeoDaemonOptions {
	/** Unix socket path (POSIX) or named-pipe path (Windows) to bind. */
	readonly listenPath: string;
	/** Absolute cwd this daemon serves. */
	readonly cwd: string;
	/** Agent dir (holds the registry). */
	readonly agentDir: string;
	/** Self-register into the registry as the last listen step. Default true. */
	readonly register?: boolean;
	/** Idle shutdown period in ms; 0 disables. Default 30 min (caller supplies). */
	readonly idleShutdownMs: number;
	/** Handshake token clients must present. */
	readonly token: string;
	/** Protocol version this daemon speaks. Default NEO_DAEMON_PROTOCOL_VERSION. */
	readonly version?: number;
	/** Worker factory (injected in tests; production spawns a child process). */
	readonly workerFactory: NeoDaemonWorkerFactory;
	/** Injectable clock for idle-shutdown timing. */
	readonly clock?: NeoDaemonClock;
	/**
	 * Validate connection runtimeOptions; return a human reason to refuse, or
	 * undefined to accept. Lets the host reject options it cannot honor.
	 */
	readonly validateRuntimeOptions?: (options: NeoRuntimeOptions) => string | undefined;
}

export interface NeoDaemonHandle {
	/** The bound socket path. */
	readonly listenPath: string;
	/** Resolves when the daemon has fully shut down. */
	readonly closed: Promise<void>;
	/** Current live connection count (for tests/observability). */
	connectionCount(): number;
	/** Trigger a graceful shutdown. */
	shutdown(): Promise<void>;
}

/** Raised when the socket path is already bound (a daemon already won the race). */
export class NeoDaemonAddressInUseError extends Error {
	constructor(listenPath: string) {
		super(`Neo daemon socket already in use: ${listenPath}`);
		this.name = "NeoDaemonAddressInUseError";
	}
}

/**
 * Start the neo daemon. Binds the socket (throws {@link NeoDaemonAddressInUseError}
 * if the race is lost), registers, and serves connections until idle-shutdown or
 * an explicit `shutdown()`.
 */
export async function runNeoDaemon(options: NeoDaemonOptions): Promise<NeoDaemonHandle> {
	const version = options.version ?? NEO_DAEMON_PROTOCOL_VERSION;
	const register = options.register ?? true;
	const clock = options.clock ?? realClock;

	// Stale cleanup BEFORE bind so a dead daemon's leftover socket/record does
	// not block the fresh bind.
	cleanupStaleNeoDaemon(options.agentDir, options.cwd);

	const connections = new Set<ConnectionState>();
	let idleTimer: unknown;
	let shuttingDown = false;
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	const server: Server = createServer();

	const clearIdleTimer = (): void => {
		if (idleTimer !== undefined) {
			clock.clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};

	const armIdleTimer = (): void => {
		clearIdleTimer();
		if (options.idleShutdownMs <= 0) return;
		if (connections.size > 0) return;
		idleTimer = clock.setTimeout(() => {
			void shutdown();
		}, options.idleShutdownMs);
	};

	async function shutdown(): Promise<void> {
		if (shuttingDown) return closed;
		shuttingDown = true;
		clearIdleTimer();
		// Dispose all live connections (aborts each in-flight turn).
		const disposals = [...connections].map((c) => c.teardown());
		await Promise.allSettled(disposals);
		connections.clear();
		if (register) {
			removeNeoDaemonRecord(options.agentDir, options.cwd);
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
		resolveClosed();
		return closed;
	}

	server.on("connection", (socket: Socket) => {
		void handleConnection(socket);
	});

	async function handleConnection(socket: Socket): Promise<void> {
		clearIdleTimer();
		socket.setNoDelay(true);
		const abort = new AbortController();
		const state: ConnectionState = {
			socket,
			worker: undefined,
			async teardown() {
				abort.abort();
				detach();
				try {
					await this.worker?.dispose();
				} finally {
					if (!socket.destroyed) socket.destroy();
				}
			},
		};

		const writeToClient = (line: string): void => {
			if (!socket.destroyed) socket.write(line);
		};

		const reply = (message: NeoDaemonHandshakeReply): void => {
			writeToClient(serializeJsonLine(message));
		};

		let handshakeDone = false;

		const onLine = (line: string): void => {
			if (handshakeDone) {
				state.worker?.handleLine(line);
				return;
			}
			handshakeDone = true;
			void completeHandshake(line);
		};

		const detach = attachJsonlLineReader(socket, onLine);

		const finalizeDrop = (): void => {
			if (!connections.has(state)) return;
			connections.delete(state);
			void state.teardown();
			armIdleTimer();
		};
		socket.on("close", finalizeDrop);
		socket.on("error", finalizeDrop);

		async function completeHandshake(firstLine: string): Promise<void> {
			const hello = parseHello(firstLine);
			if (!hello) {
				reply({ type: "refuse", code: "malformed_hello", reason: "First line was not a valid hello message" });
				socket.end();
				return;
			}
			const refusal = validateHello(hello, { token: options.token, version });
			if (refusal) {
				reply(refusal);
				socket.end();
				return;
			}
			const runtimeOptions = hello.runtimeOptions ?? {};
			const optionError = options.validateRuntimeOptions?.(runtimeOptions);
			if (optionError) {
				reply({ type: "refuse", code: "unsupported_options", reason: optionError });
				socket.end();
				return;
			}

			// Accepted: build the per-connection worker, then welcome.
			try {
				const worker = await options.workerFactory({
					runtimeOptions,
					capabilities: hello.capabilities ?? [],
					cwd: options.cwd,
					agentDir: options.agentDir,
					writeToClient,
					signal: abort.signal,
				});
				state.worker = worker;
				connections.add(state);
				reply({ type: "welcome", version, capabilities: hello.capabilities });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				reply({ type: "refuse", code: "unsupported_options", reason: `Failed to start runtime: ${message}` });
				socket.end();
			}
		}
	}

	// Bind FIRST (the mutex). Map EADDRINUSE to a typed error so the caller can
	// attach to the winner.
	await new Promise<void>((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			server.off("listening", onListening);
			if (error.code === "EADDRINUSE") {
				reject(new NeoDaemonAddressInUseError(options.listenPath));
			} else {
				reject(error);
			}
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(options.listenPath);
	});

	// Registry self-registration is the LAST listen step.
	if (register) {
		const record: NeoDaemonRecord = {
			version,
			socket: options.listenPath,
			pid: process.pid,
			token: options.token,
		};
		writeNeoDaemonRecord(options.agentDir, options.cwd, record);
	}

	// No connections yet: arm the idle timer immediately.
	armIdleTimer();

	return {
		listenPath: options.listenPath,
		closed,
		connectionCount: () => connections.size,
		shutdown,
	};
}

interface ConnectionState {
	socket: Socket;
	worker: NeoDaemonWorker | undefined;
	teardown(): Promise<void>;
}

export type { NeoHelloMessage };
