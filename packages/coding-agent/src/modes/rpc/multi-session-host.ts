import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import { envValue } from "../../core/brand.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import type { RpcConnectionSink } from "./connection-handler.ts";
import { parseClientCapabilities } from "./custom-capability.ts";
import { parseIdleExitMs } from "./host-lifecycle.ts";
import { armHostWatchdog, readHostWatchdogConfigFromBrandEnv } from "./host-watchdog.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { rpcCommandShapeError } from "./rpc-input-validation.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { type RpcBindingFactory, SessionCommandRouter } from "./session-command-router.ts";
import { SessionEventWriter } from "./session-event-writer.ts";
import { RpcSessionRegistry } from "./session-registry.ts";
import {
	authenticateSocket,
	ensureSocketSecret,
	resolveSocketTransportAddress,
	SOCKET_SECRET_FILE_ENV,
	socketSecretPath,
} from "./socket-transport.ts";

export interface MultiSessionHostOptions {
	agentDir: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
	cwd: string;
	permissionPreset?: string;
	creationModel?: { provider: string; modelId: string };
	initialThinkingLevel?: string;
	listen?: string;
	/** Test seam: defaults to the real shared-session binding. */
	createBinding?: RpcBindingFactory;
}

/** Environment override for the idle-session eviction window, in milliseconds. */
export const RPC_SESSION_IDLE_EVICTION_MS_ENV = "SENPI_RPC_SESSION_IDLE_EVICTION_MS";
/** Environment override for the concurrent open-session cap. */
export const RPC_MAX_SESSIONS_ENV = "SENPI_RPC_MAX_SESSIONS";
/** Environment override for the empty-host exit window, in milliseconds. */
export const RPC_HOST_EMPTY_EXIT_MS_ENV = "SENPI_RPC_HOST_EMPTY_EXIT_MS";
/** Default idle-eviction window: 30 minutes after a session's last routed command or settled turn. */
export const DEFAULT_SESSION_IDLE_EVICTION_MS = 30 * 60_000;
/** Default session cap: an idle session holds a full runtime (~340-510 MB RSS measured). */
export const DEFAULT_MAX_SESSIONS = 8;
/** Default empty-host exit: 15 minutes with zero open sessions, matching the supervisor's idle window. */
export const DEFAULT_HOST_EMPTY_EXIT_MS = 15 * 60_000;
/** Win32 named-pipe close can leave libuv's server callback pending after handles are destroyed. */
const WINDOWS_SHUTDOWN_HARD_EXIT_MS = 2_000;

/** Explicit occupancy-policy overrides for createHostCore; tests inject clocks and hooks here. */
export interface HostIdleOverrides {
	now?: () => number;
	idleEvictionMs?: number;
	emptyExitMs?: number;
	maxSessions?: number;
	/** Shutdown hook the empty-exit window invokes; hosts pass their exit path. */
	onEmptyExit?: () => void;
	/** Gate consulted before the empty-exit window advances (connected clients block it). */
	canExitWhenEmpty?: () => boolean;
}

function parseSessionCap(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Precedence: explicit overrides beat environment variables beat documented defaults. */
export function resolveHostIdlePolicy(
	env: Readonly<Record<string, string | undefined>>,
	overrides: HostIdleOverrides = {},
): { now: () => number; idleEvictionMs: number; emptyExitMs: number; maxSessions: number } {
	return {
		now: overrides.now ?? Date.now,
		idleEvictionMs:
			overrides.idleEvictionMs ??
			parseIdleExitMs(env[RPC_SESSION_IDLE_EVICTION_MS_ENV]) ??
			DEFAULT_SESSION_IDLE_EVICTION_MS,
		emptyExitMs:
			overrides.emptyExitMs ?? parseIdleExitMs(env[RPC_HOST_EMPTY_EXIT_MS_ENV]) ?? DEFAULT_HOST_EMPTY_EXIT_MS,
		maxSessions: overrides.maxSessions ?? parseSessionCap(env[RPC_MAX_SESSIONS_ENV]) ?? DEFAULT_MAX_SESSIONS,
	};
}

interface Connection {
	readonly id: string;
	readonly sink: RpcConnectionSink;
	readonly detach: () => void;
	readonly close: () => void;
}

/**
 * Socket event visibility is an all-sessions broadcast: every connected client
 * receives every session lifecycle/agent event, tagged with its routing
 * sessionId. Responses and extension UI requests remain requester-only. This
 * keeps observers stateless while preventing correlated replies from leaking.
 */
export async function runMultiSessionHost(options: MultiSessionHostOptions): Promise<never> {
	if (options.listen === undefined || options.listen === "stdio://") return runStdioHost(options);
	return runSocketHost(options, resolveSocketPath(options.listen, options.agentDir));
}

export function createHostCore(
	options: MultiSessionHostOptions,
	writer: SessionEventWriter,
	capabilities = parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")),
	idle: HostIdleOverrides = {},
) {
	const policy = resolveHostIdlePolicy(process.env, idle);
	const router = new SessionCommandRouter(
		new RpcSessionRegistry({
			agentDir: options.agentDir,
			createRuntime: options.createRuntime,
			now: policy.now,
			maxSessions: policy.maxSessions,
		}),
		writer,
		options,
		options.createBinding,
		{ capabilities },
		{
			now: policy.now,
			idleEvictionMs: policy.idleEvictionMs,
			emptyExitMs: policy.emptyExitMs,
			onEmptyExit: idle.onEmptyExit,
			canExitWhenEmpty: idle.canExitWhenEmpty,
		},
	);
	const handle = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (cause) {
			await writer.enqueueControl(parseError(`Failed to parse command: ${errorMessage(cause)}`));
			return;
		}
		const shapeError = rpcCommandShapeError(parsed);
		if (shapeError) {
			await writer.enqueueControl(parseError(shapeError));
			return;
		}
		const response = await router.handle(parsed as RpcCommand);
		if (response) await writer.enqueueControl(response);
	};
	return { router, handle };
}

/** Plain-stdio host with no eagerly-created AgentSessionRuntime. */
async function runStdioHost(options: MultiSessionHostOptions): Promise<never> {
	takeOverStdout();
	const sink: RpcConnectionSink = { writeRaw: writeRawStdout, waitForBackpressure: waitForRawStdoutBackpressure };
	const writer = new SessionEventWriter(sink.writeRaw, sink.waitForBackpressure);
	// An empty host (no session ever opened, or all closed) must not stay resident
	// forever: exit through the normal shutdown path once the window elapses.
	const { router, handle } = createHostCore(options, writer, undefined, {
		onEmptyExit: () => void shutdown(0),
	});
	let shuttingDown = false;
	const shutdown = async (exitCode = 0): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		detach();
		await router.dispose();
		await writer.flush();
		await flushRawStdout();
		process.exit(exitCode);
	};
	const onEnd = () => void shutdown();
	process.stdin.on("end", onEnd);
	const detachReader = attachJsonlLineReader(process.stdin, (line) => void handle(line), {
		maxLineLength: MAX_RPC_LINE_CHARACTERS,
		onOversizedLine: () => void writer.enqueueControl(parseError(oversizedLineError())),
	});
	const detach = () => {
		detachReader();
		process.stdin.off("end", onEnd);
	};
	registerShutdownSignals(shutdown);
	return new Promise(() => {});
}

async function runSocketHost(options: MultiSessionHostOptions, socketPath: string): Promise<never> {
	await prepareSocketPath(socketPath);
	const writer = new SessionEventWriter(() => {});
	const connections = new Map<string, Connection>();
	const { router, handle } = createHostCore(
		options,
		writer,
		parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")).filter(
			(capability) => capability !== "rendered_components",
		),
		// Supervised hosts idle-exit via the supervisor, but a socket host that
		// outlives its supervisor (or is started bare) still self-exits when empty.
		// A connected client counts as occupancy even with no session open: exiting
		// under it would drop its socket and read as a crash to the supervisor.
		{ onEmptyExit: () => void shutdown(0), canExitWhenEmpty: () => connections.size === 0 },
	);
	let nextConnection = 0;
	let shuttingDown = false;
	const secret =
		process.platform === "win32"
			? await ensureSocketSecret(process.env[SOCKET_SECRET_FILE_ENV] ?? socketSecretPath(socketPath))
			: undefined;
	const server = createServer((socket) => {
		const accept = (): void => {
			const id = `socket-${++nextConnection}`;
			const sink = socketSink(socket);
			writer.registerConnection(id, sink);
			const detachReader = attachJsonlLineReader(
				socket,
				(line) => {
					// Do not serialize awaited commands: extension_ui_response and other
					// re-entrant frames must be able to resolve a command already awaiting them.
					void writer
						.withConnection(id, () => handle(line))
						.catch((cause) => {
							process.stderr.write(`senpi rpc connection ${id} failed: ${errorMessage(cause)}\n`);
						});
				},
				{
					maxLineLength: MAX_RPC_LINE_CHARACTERS,
					onOversizedLine: () => {
						void writer
							.withConnection(id, () => writer.enqueueControl(parseError(oversizedLineError())))
							.catch((cause) =>
								process.stderr.write(`senpi rpc connection ${id} failed: ${errorMessage(cause)}\n`),
							);
					},
				},
			);
			let detached = false;
			const detach = () => {
				if (detached) return;
				detached = true;
				detachReader();
				writer.unregisterConnection(id);
				connections.delete(id);
				// A socket that dies without close_session still owns its sessions' attachments
				// and path reservations. Release them on the command chain so this runs after any
				// in-flight command for this connection settles, otherwise the path stays pinned
				// by a runtime whose client is gone and later resumes attach to that orphan.
				void router.releaseConnection(id).catch((cause) => {
					process.stderr.write(`senpi rpc connection ${id} release failed: ${errorMessage(cause)}\n`);
				});
			};
			connections.set(id, { id, sink, detach, close: () => socket.destroy() });
			socket.once("close", detach);
			socket.once("error", () => detach());
		};
		if (secret) authenticateSocket(socket, secret, accept);
		else accept();
	});
	server.on("error", (cause) => {
		if (!shuttingDown) process.stderr.write(`senpi rpc socket listener failed: ${errorMessage(cause)}\n`);
	});
	const shutdown = async (exitCode = 0, watchdogCleanup?: Promise<void>): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		// On Windows, destroying named-pipe sockets does not always make libuv's
		// server.close callback fire: connected pipe instances can remain in the
		// kernel after the JavaScript handles are destroyed. Keep the normal drain
		// path, but never let that platform-specific close stall orphan the host.
		try {
			for (const connection of connections.values()) {
				connection.detach();
				connection.close();
			}
			await (process.platform === "win32"
				? Promise.race([closeServer(server), delay(WINDOWS_SHUTDOWN_HARD_EXIT_MS)])
				: closeServer(server));
			await router.dispose();
			await writer.flush();
			await removeSocketPath(socketPath);
			if (watchdogCleanup) await watchdogCleanup;
		} finally {
			// Explicitly terminate after every shutdown trigger. Windows named-pipe
			// handles are not fully controllable from JS, and an unresolved cleanup
			// must not leave this daemon or its public endpoint alive.
			process.exit(exitCode);
		}
	};
	registerShutdownSignals(shutdown);
	// Arm before listen: a supervisor death during the listen transition must
	// still close the child and clean its private endpoint.
	armHostWatchdog(readHostWatchdogConfigFromBrandEnv(), (reason, cleanup) => {
		process.stderr.write(`senpi rpc host: ${reason}; shutting down\n`);
		// Enter shutdown before killing session-owned child processes. The Windows
		// tree killer is synchronous, while the shutdown fallback must be armed
		// before any such cleanup can delay the event loop.
		void shutdown(0, cleanup);
		setImmediate(killTrackedDetachedChildren);
	});
	await listen(server, socketPath, secret);
	process.stderr.write(`senpi rpc listening on ${formatSocketAddress(socketPath)}\n`);

	// Opt-in only: set by the lifecycle supervisor so this host can never outlive
	// it, including when the supervisor is SIGKILLed and runs no handler at all.
	return new Promise(() => {});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseError(error: string): RpcResponse {
	return { type: "response", command: "parse", success: false, error };
}

function oversizedLineError(): string {
	return `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function resolveSocketPath(value: string, agentDir: string): string {
	if (value === "unix://") return join(agentDir, "rpc", "rpc.sock");
	if (value.startsWith("unix://")) {
		const path = value.slice("unix://".length);
		if (path.length === 0) return join(agentDir, "rpc", "rpc.sock");
		if (path.startsWith("@") && process.platform === "linux") return `\0${path.slice(1)}`;
		return path;
	}
	return value;
}

function formatSocketAddress(socketPath: string): string {
	return socketPath.startsWith("\0") ? `unix://@${socketPath.slice(1)}` : `unix://${socketPath}`;
}

function socketSink(socket: Socket): RpcConnectionSink {
	let needsDrain = false;
	return {
		writeRaw(chunk) {
			if (!socket.destroyed) needsDrain = !socket.write(chunk);
		},
		waitForBackpressure() {
			if (socket.destroyed || !needsDrain) return Promise.resolve();
			needsDrain = false;
			return new Promise<void>((resolve) => {
				const done = () => {
					socket.off("drain", done);
					socket.off("close", done);
					resolve();
				};
				socket.once("drain", done);
				socket.once("close", done);
			});
		},
	};
}

async function prepareSocketPath(socketPath: string): Promise<void> {
	if (process.platform === "win32" || socketPath.startsWith("\0")) return;
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	try {
		await access(socketPath);
	} catch (cause) {
		if (isNodeErrorCode(cause, "ENOENT")) return;
		throw cause;
	}
	if (await probeSocket(socketPath)) throw new Error(`${socketPath}: address already in use by a live server.`);
	await unlink(socketPath);
}

function probeSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform));
		const settle = (live: boolean) => {
			socket.destroy();
			resolve(live);
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
		socket.setTimeout(1_000, () => settle(false));
	});
}

function listen(server: Server, socketPath: string, secret?: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(resolveSocketTransportAddress(socketPath, process.platform, secret), async () => {
			server.off("error", reject);
			try {
				if (process.platform !== "win32" && !socketPath.startsWith("\0")) await chmod(socketPath, 0o600);
				resolve();
			} catch (cause) {
				reject(cause);
			}
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((cause) => (cause ? reject(cause) : resolve()));
	});
}

async function removeSocketPath(socketPath: string): Promise<void> {
	if (process.platform === "win32" || socketPath.startsWith("\0")) return;
	try {
		await unlink(socketPath);
	} catch (cause) {
		if (!isNodeErrorCode(cause, "ENOENT")) throw cause;
	}
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

function registerShutdownSignals(shutdown: (exitCode?: number) => Promise<never>): void {
	for (const signal of process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const)) {
		process.on(signal, () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGHUP" ? 129 : 143);
		});
	}
}
