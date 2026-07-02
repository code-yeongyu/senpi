import { isIP } from "node:net";
import { APP_NAME, ENV_SESSION_DIR, getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../../core/sdk.ts";
import type {
	ThreadLoadedListResponse,
	TurnInterruptParams,
	TurnStartParams,
	TurnSteerParams,
	UserInput,
} from "./protocol/index.ts";
import type { ClassifiedIncoming, RpcEnvelope, RpcResponse } from "./rpc/envelope.ts";
import { createRegistry, type MethodRegistry, type RpcRequest } from "./rpc/registry.ts";
import { ApprovalBridge, createAppServerUIContext } from "./server/approvals.ts";
import type { Connection, ConnectionId, ConnectionInput, TransportKind } from "./server/connection.ts";
import { type ConnectionTransport, NotificationRouter } from "./server/notifications.ts";
import { ServerCore } from "./server/server-core.ts";
import { decodeCursor, encodeCursor, objectValue, optionalNumber, optionalString } from "./threads/handler-params.ts";
import { registerThreadLifecycleHandlers } from "./threads/handlers.ts";
import { type ThreadEntry, ThreadNotFoundError, ThreadRegistry } from "./threads/registry.ts";
import { TurnLog } from "./threads/turn-log.ts";
import { TurnEngineError } from "./threads/turn-runtime.ts";
import {
	createTurnEngine,
	type TurnEngineApi,
	type TurnEngineSession,
	type TurnEngineStore,
	type TurnEngineThreadEntry,
} from "./threads/turns.ts";
import { buildWireThread } from "./threads/wire-thread.ts";
import { type StdioTransport, startStdioTransport } from "./transports/stdio.ts";
import {
	startAppServerWebSocketListener,
	type WebSocketListenerAuth,
	type WebSocketListenerHandle,
} from "./transports/websocket.ts";

export type AppServerDaemonVerb = "start" | "stop" | "status" | "restart";

export type AppServerListen =
	| { readonly kind: "stdio"; readonly url: "stdio://" }
	| { readonly kind: "unix"; readonly url: string; readonly path?: string }
	| { readonly kind: "ws"; readonly url: string; readonly host: string; readonly port: number };

export type AppServerWsAuth = { readonly kind: "off" } | { readonly kind: "token-file"; readonly path: string };

export interface AppServerModeOptions {
	readonly kind: "server";
	readonly listen: AppServerListen;
	readonly wsAuth?: AppServerWsAuth;
	readonly jsonLogs: boolean;
}

export interface AppServerDaemonCommandOptions {
	readonly kind: "daemon";
	readonly verb: AppServerDaemonVerb;
	readonly listen: AppServerListen;
}

export interface AppServerUsageError {
	readonly kind: "usage-error";
	readonly message: string;
}

export type AppServerCliArgs = AppServerModeOptions | AppServerDaemonCommandOptions | AppServerUsageError;

export const APP_SERVER_LISTEN_USAGE =
	"Invalid --listen value. Use stdio://, unix://, unix:///abs/path, or ws://IP:PORT.";

export function formatAppServerUsage(): string {
	const listenForms = "stdio://|unix://|unix:///abs/path|ws://IP:PORT";
	return [
		`Usage: ${APP_NAME} app-server [--listen <${listenForms}>] [--ws-auth <token-file|off>] [--json-logs]`,
		`       ${APP_NAME} app-server daemon <start|stop|status|restart> [--listen <${listenForms}>]`,
	].join("\n");
}

function parseListen(value: string): AppServerListen | undefined {
	if (value === "stdio://") {
		return { kind: "stdio", url: "stdio://" };
	}

	if (value === "unix://") {
		return { kind: "unix", url: "unix://" };
	}

	if (value.startsWith("unix:///")) {
		const path = value.slice("unix://".length);
		if (path.startsWith("/")) {
			return { kind: "unix", url: value, path };
		}
		return undefined;
	}

	if (!value.startsWith("ws://")) {
		return undefined;
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch (error: unknown) {
		if (error instanceof TypeError) {
			return undefined;
		}
		throw error;
	}

	const port = Number(parsed.port);
	if (
		parsed.protocol !== "ws:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.port === "" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		isIP(parsed.hostname) === 0
	) {
		return undefined;
	}

	return { kind: "ws", url: value, host: parsed.hostname, port };
}

function parseDaemonVerb(value: string | undefined): AppServerDaemonVerb | undefined {
	switch (value) {
		case "start":
		case "stop":
		case "status":
		case "restart":
			return value;
		default:
			return undefined;
	}
}

function parseWsAuth(value: string): AppServerWsAuth {
	return value === "off" ? { kind: "off" } : { kind: "token-file", path: value };
}

function parseServerArgs(args: readonly string[]): AppServerModeOptions | AppServerUsageError {
	let listen: AppServerListen = { kind: "stdio", url: "stdio://" };
	let wsAuth: AppServerWsAuth | undefined;
	let jsonLogs = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--listen") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: APP_SERVER_LISTEN_USAGE };
			}
			const parsed = parseListen(value);
			if (parsed === undefined) {
				return { kind: "usage-error", message: APP_SERVER_LISTEN_USAGE };
			}
			listen = parsed;
			index++;
			continue;
		}
		if (arg === "--ws-auth") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: "--ws-auth requires <token-file|off>." };
			}
			wsAuth = parseWsAuth(value);
			index++;
			continue;
		}
		if (arg === "--json-logs") {
			jsonLogs = true;
			continue;
		}
		return { kind: "usage-error", message: `Unexpected app-server argument: ${arg}` };
	}

	return { kind: "server", listen, wsAuth, jsonLogs };
}

function parseDaemonArgs(args: readonly string[]): AppServerDaemonCommandOptions | AppServerUsageError {
	const verb = parseDaemonVerb(args[0]);
	if (verb === undefined) {
		return { kind: "usage-error", message: "Usage: app-server daemon <start|stop|status|restart>." };
	}

	let listen: AppServerListen = { kind: "ws", url: "ws://127.0.0.1:18800", host: "127.0.0.1", port: 18800 };
	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--listen") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: APP_SERVER_LISTEN_USAGE };
			}
			const parsed = parseListen(value);
			if (parsed === undefined) {
				return { kind: "usage-error", message: APP_SERVER_LISTEN_USAGE };
			}
			listen = parsed;
			index++;
			continue;
		}
		return { kind: "usage-error", message: `Unexpected app-server daemon argument: ${arg}` };
	}

	return { kind: "daemon", verb, listen };
}

export function parseAppServerCliArgs(args: readonly string[]): AppServerCliArgs {
	if (args[0] === "daemon") {
		return parseDaemonArgs(args.slice(1));
	}
	return parseServerArgs(args);
}

export async function runAppServerMode(options: AppServerModeOptions): Promise<void> {
	let shutdownRequested = false;
	let forceExit = false;
	let resolveShutdown: (reason: string) => void = () => {};
	const shutdownSignal = new Promise<string>((resolve) => {
		resolveShutdown = resolve;
	});

	const requestShutdown = (reason: string): void => {
		if (shutdownRequested) {
			if (!forceExit) {
				forceExit = true;
				process.exit(1);
			}
			return;
		}
		shutdownRequested = true;
		resolveShutdown(reason);
	};

	const handleSignal = (signal: NodeJS.Signals): void => {
		requestShutdown(signal);
	};

	process.on("SIGINT", handleSignal);
	process.on("SIGTERM", handleSignal);

	const runtime = createAppServerRuntime(requestShutdown);
	let stdio: StdioTransport | undefined;
	let websocket: WebSocketListenerHandle | undefined;
	try {
		if (options.listen.kind === "stdio") {
			stdio = startStdioTransport({
				core: runtime.core,
				onShutdown: requestShutdown,
			});
			process.stderr.write("senpi app-server listening on stdio://\n");
		} else if (options.listen.kind === "ws") {
			websocket = await startAppServerWebSocketListener({
				core: runtime.core,
				host: options.listen.host,
				port: options.listen.port,
				auth: toWebSocketAuth(options.wsAuth),
			});
			process.stderr.write(`senpi app-server listening on ws://${websocket.host}:${websocket.port}\n`);
			process.stderr.write(`readyz http://127.0.0.1:${websocket.port}/readyz\n`);
			if (websocket.tokenFile) {
				process.stderr.write(`token ${websocket.tokenFile}\n`);
			}
		} else {
			throw new AppServerModeUsageError("unix app-server listen is not implemented yet.");
		}

		const reason = await shutdownSignal;
		await withShutdownDeadline(interruptActiveTurns(runtime), 5_000);
		await withShutdownDeadline(shutdownTransports({ stdio, websocket, reason }), 5_000);
		process.exitCode = 0;
	} finally {
		process.off("SIGINT", handleSignal);
		process.off("SIGTERM", handleSignal);
	}
}

export async function runAppServerDaemonCommand(_options: AppServerDaemonCommandOptions): Promise<never> {
	console.error("app-server mode scaffolding — not yet wired");
	process.exit(3);
}

type AppServerRuntime = {
	readonly core: ServerCore;
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
	readonly turns: TurnEngineApi;
};

class AppServerModeUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AppServerModeUsageError";
	}
}

class RoutedServerCore extends ServerCore {
	private readonly notifications: NotificationRouter;
	private readonly approvals: ApprovalBridge;

	constructor(registry: MethodRegistry, notifications: NotificationRouter, approvals: ApprovalBridge) {
		super({ registry });
		this.notifications = notifications;
		this.approvals = approvals;
	}

	override addConnection(input: ConnectionInput): Connection {
		const connection = super.addConnection(input);
		this.notifications.addConnection({
			id: connection.id,
			get initialized() {
				return connection.initialized;
			},
			get transport() {
				return routerTransport(connection.transportKind);
			},
			get capabilities() {
				return connection.capabilities;
			},
			get optOutNotificationMethods() {
				return [...connection.optOutNotificationMethods];
			},
			send: (notification) => connection.send(notification as RpcEnvelope),
			close: () => {
				void connection.close("slow-client");
			},
		});
		return connection;
	}

	override removeConnection(id: ConnectionId): void {
		this.notifications.removeConnection(id);
		super.removeConnection(id);
	}

	override async receive(connectionId: ConnectionId, envelope: ClassifiedIncoming): Promise<void> {
		if (envelope.kind === "response" && this.resolveApproval(envelope.message)) {
			return;
		}
		await super.receive(connectionId, envelope);
	}

	private resolveApproval(response: RpcResponse): boolean {
		const id = response.id;
		if (id === null) {
			return false;
		}
		if ("result" in response) {
			return this.approvals.resolveResponse({ id, result: response.result });
		}
		return this.approvals.resolveResponse({ id, error: response.error });
	}
}

function createAppServerRuntime(requestShutdown: (reason: string) => void): AppServerRuntime {
	const notifications = new NotificationRouter();
	const registry = createRegistry();
	let threads: ThreadRegistry;
	const approvals = new ApprovalBridge((threadId, message) => {
		let subscriberCount = 0;
		try {
			subscriberCount = threads.getLoadedThread(threadId).subscribers.size;
		} catch (error: unknown) {
			if (error instanceof ThreadNotFoundError) {
				return 0;
			}
			throw error;
		}
		notifications.toThread(threadId, message);
		return subscriberCount;
	});
	const core = new RoutedServerCore(registry, notifications, approvals);
	threads = new ThreadRegistry({
		agentDir: getAgentDir(),
		sessionDir: process.env[ENV_SESSION_DIR],
		createSession: (options) => createBoundAppServerSession(options, approvals, notifications, requestShutdown),
	});
	const turnLog = new TurnLog();
	const turns = createTurnEngine({
		store: new ModeTurnStore(threads),
		turnLog,
		emitToThread: (threadId, notification) => notifications.toThread(threadId, notification),
		broadcast: (notification) => notifications.broadcast(notification),
	});
	registerTurnHandlers(registry, turns);

	registerThreadLifecycleHandlers(registry, {
		threads,
		turnLog,
		notifications,
		idleUnloadMinutes: 30,
	});
	registerLoadedThreadObjectListHandler(registry, threads, turnLog);

	return { core, threads, turnLog, turns };
}

async function createBoundAppServerSession(
	options: CreateAgentSessionOptions,
	approvals: ApprovalBridge,
	notifications: NotificationRouter,
	requestShutdown: (reason: string) => void,
): Promise<CreateAgentSessionResult> {
	const result = await createAgentSession(options);
	const threadId = result.session.sessionId;
	await result.session.bindExtensions({
		uiContext: createAppServerUIContext(approvals, threadId),
		mode: "rpc",
		shutdownHandler: () => requestShutdown("extension shutdown"),
		onError: (error) => {
			notifications.toThread(threadId, { method: "error", params: error });
		},
	});
	result.session.subscribe((event) => {
		if (event.type === "agent_end") {
			approvals.cancelPendingForThread(threadId);
		}
	});
	return result;
}

function registerTurnHandlers(registry: MethodRegistry, turns: TurnEngineApi): void {
	registry.register("turn/start", {
		scope: "thread",
		handler: (context) => turns.startTurn(turnStartParams(context.request)),
	});
	registry.register("turn/steer", {
		scope: "thread",
		handler: (context) => turns.steerTurn(turnSteerParams(context.request)),
	});
	registry.register("turn/interrupt", {
		scope: "thread",
		handler: (context) => turns.interruptTurn(turnInterruptParams(context.request)),
	});
}

function registerLoadedThreadObjectListHandler(
	registry: MethodRegistry,
	threads: ThreadRegistry,
	turnLog: TurnLog,
): void {
	registry.register("thread/loaded/list", {
		scope: "thread",
		handler: (context) => {
			const params = objectValue(context.request.params);
			const cursor = decodeCursor(optionalString(params.cursor) ?? null);
			const limit = optionalNumber(params.limit) ?? Number.POSITIVE_INFINITY;
			const loaded = threads.listLoaded();
			const data = loaded.slice(cursor, cursor + limit);
			const nextOffset = cursor + data.length;
			return {
				data: data.map((thread) => buildWireThread(thread, turnLog, false)),
				nextCursor: nextOffset < loaded.length ? encodeCursor(nextOffset) : null,
			} satisfies ThreadLoadedListResponse;
		},
	});
}

class ModeTurnStore implements TurnEngineStore<ModeTurnEntry> {
	private readonly threads: ThreadRegistry;

	constructor(threads: ThreadRegistry) {
		this.threads = threads;
	}

	getLoadedThread(threadId: string): ModeTurnEntry {
		return new ModeTurnEntry(this.threads.getLoadedThread(threadId));
	}

	runThreadTask<T>(threadId: string, task: () => Promise<T> | T): Promise<T> {
		return this.threads.runThreadTask(threadId, task);
	}
}

class ModeTurnEntry implements TurnEngineThreadEntry {
	private readonly entry: ThreadEntry;
	private readonly sessionAdapter: TurnEngineSession;

	constructor(entry: ThreadEntry) {
		this.entry = entry;
		this.sessionAdapter = new ModeTurnSession(entry.session);
	}

	get id(): string {
		return this.entry.id;
	}

	get session(): TurnEngineSession {
		return this.sessionAdapter;
	}

	get activeTurn() {
		return this.entry.activeTurn;
	}

	set activeTurn(value) {
		this.entry.activeTurn = value;
	}

	get status() {
		return this.entry.status;
	}

	set status(value) {
		this.entry.status = value;
	}

	get updatedAt(): string {
		return this.entry.updatedAt;
	}

	set updatedAt(value: string) {
		this.entry.updatedAt = value;
	}
}

class ModeTurnSession implements TurnEngineSession {
	private readonly session: AgentSession;

	constructor(session: AgentSession) {
		this.session = session;
	}

	prompt(
		text: string,
		options?: { readonly source?: "rpc"; readonly preflightResult?: (success: boolean) => void },
	): Promise<void> {
		return this.session.prompt(text, options);
	}

	steer(text: string): Promise<void> {
		return this.session.steer(text);
	}

	abort(): Promise<void> {
		return this.session.abort();
	}

	subscribe(listener: (event: { readonly type: string }) => void): () => void {
		return this.session.subscribe((event) => {
			listener({ type: event.type });
		});
	}
}

function objectParams(request: RpcRequest): Readonly<Record<string, unknown>> {
	if (typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)) {
		return Object.fromEntries(Object.entries(request.params));
	}
	throw new TurnEngineError({ code: -32602, message: "Invalid params" });
}

function turnStartParams(request: RpcRequest): TurnStartParams {
	const params = objectParams(request);
	return {
		threadId: requiredStringParam(params.threadId, "threadId"),
		clientUserMessageId: optionalNullableStringParam(params.clientUserMessageId, "clientUserMessageId"),
		input: userInputArrayParam(params.input),
	};
}

function turnSteerParams(request: RpcRequest): TurnSteerParams {
	const params = objectParams(request);
	return {
		threadId: requiredStringParam(params.threadId, "threadId"),
		expectedTurnId: requiredStringParam(params.expectedTurnId, "expectedTurnId"),
		clientUserMessageId: optionalNullableStringParam(params.clientUserMessageId, "clientUserMessageId"),
		input: userInputArrayParam(params.input),
	};
}

function turnInterruptParams(request: RpcRequest): TurnInterruptParams {
	const params = objectParams(request);
	return {
		threadId: requiredStringParam(params.threadId, "threadId"),
		turnId: requiredStringParam(params.turnId, "turnId"),
	};
}

function requiredStringParam(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TurnEngineError({ code: -32602, message: `Invalid params: ${name} is required` });
	}
	return value;
}

function optionalNullableStringParam(value: unknown, name: string): string | null | undefined {
	if (value === undefined || value === null) {
		return value;
	}
	if (typeof value !== "string") {
		throw new TurnEngineError({ code: -32602, message: `Invalid params: ${name} must be a string` });
	}
	return value;
}

function userInputArrayParam(value: unknown): readonly UserInput[] {
	if (!Array.isArray(value)) {
		throw new TurnEngineError({ code: -32602, message: "Invalid params: input must be an array" });
	}
	return value.map(userInputParam);
}

function userInputParam(value: unknown): UserInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TurnEngineError({ code: -32602, message: "Invalid params: input item must be an object" });
	}
	const item = Object.fromEntries(Object.entries(value));
	const type = item.type;
	switch (type) {
		case "text":
			return {
				type,
				text: requiredStringParam(item.text, "input.text"),
				text_elements: Array.isArray(item.text_elements) ? item.text_elements : [],
			};
		case "image":
			return { type, url: requiredStringParam(item.url, "input.url") };
		case "localImage":
			return { type, path: requiredStringParam(item.path, "input.path") };
		case "skill":
		case "mention":
			return {
				type,
				name: requiredStringParam(item.name, "input.name"),
				path: requiredStringParam(item.path, "input.path"),
			};
		default:
			throw new TurnEngineError({ code: -32602, message: "Invalid params: unsupported input item type" });
	}
}

function routerTransport(transport: TransportKind): ConnectionTransport {
	switch (transport) {
		case "stdio":
			return "stdio";
		case "websocket":
			return "ws";
		case "unix":
			return "unix";
	}
}

function toWebSocketAuth(auth: AppServerWsAuth | undefined): WebSocketListenerAuth | undefined {
	if (!auth) {
		return undefined;
	}
	if (auth.kind === "off") {
		return { kind: "off" };
	}
	return { kind: "token-file", path: auth.path };
}

async function shutdownTransports(options: {
	readonly stdio: StdioTransport | undefined;
	readonly websocket: WebSocketListenerHandle | undefined;
	readonly reason: string;
}): Promise<void> {
	await options.stdio?.drain();
	await options.stdio?.close(options.reason);
	await options.websocket?.close();
}

async function interruptActiveTurns(runtime: AppServerRuntime): Promise<void> {
	const interrupts = runtime.threads.listLoaded().map(async (thread) => {
		const entry = runtime.threads.getLoadedThread(thread.id);
		const activeTurn = entry.activeTurn;
		if (!activeTurn) {
			return;
		}
		await runtime.turns.interruptTurn({ threadId: thread.id, turnId: activeTurn.turnId });
	});
	await Promise.all(interrupts);
}

function withShutdownDeadline(task: Promise<void>, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`app-server shutdown exceeded ${timeoutMs}ms`));
		}, timeoutMs);
		task.then(
			() => {
				clearTimeout(timeout);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}
