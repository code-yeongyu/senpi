import { ENV_SESSION_DIR, getAgentDir } from "../../config.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../../core/sdk.ts";
import {
	APP_SERVER_LISTEN_USAGE,
	type AppServerCliArgs,
	type AppServerDaemonCommandOptions,
	type AppServerDaemonVerb,
	type AppServerListen,
	type AppServerModeOptions,
	type AppServerUsageError,
	type AppServerWsAuth,
	formatAppServerUsage,
	parseAppServerCliArgs,
} from "./cli-args.ts";
import { createRegistry, type MethodRegistry } from "./rpc/registry.ts";
import { ApprovalBridge, createAppServerUIContext } from "./server/approvals.ts";
import { NotificationRouter } from "./server/notifications.ts";
import type { ServerCore } from "./server/server-core.ts";
import { registerThreadLifecycleHandlers, type ThreadLifecycleController } from "./threads/handlers.ts";
import { ThreadNotFoundError, ThreadRegistry } from "./threads/registry.ts";
import { TurnLog } from "./threads/turn-log.ts";
import { createTurnEngine, type TurnEngineApi } from "./threads/turns.ts";
import { type StdioTransport, startStdioTransport } from "./transports/stdio.ts";
import { startAppServerUnixSocketListener, type UnixSocketListenerHandle } from "./transports/unix-socket.ts";
import {
	startAppServerWebSocketListener,
	type WebSocketListenerAuth,
	type WebSocketListenerHandle,
} from "./transports/websocket.ts";
import {
	createModeTurnStore,
	createRoutedServerCore,
	registerLoadedThreadObjectListHandler,
	turnInterruptParams,
	turnStartParams,
	turnSteerParams,
} from "./turn-adapter.ts";

export { runAppServerDaemonCommand } from "./daemon.ts";
export {
	APP_SERVER_LISTEN_USAGE,
	type AppServerCliArgs,
	type AppServerDaemonCommandOptions,
	type AppServerDaemonVerb,
	type AppServerListen,
	type AppServerModeOptions,
	type AppServerUsageError,
	type AppServerWsAuth,
	formatAppServerUsage,
	parseAppServerCliArgs,
};

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
	let unix: UnixSocketListenerHandle | undefined;
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
			unix = await startAppServerUnixSocketListener({
				core: runtime.core,
				socketPath: options.listen.path,
				auth: toWebSocketAuth(options.wsAuth),
			});
			process.stderr.write(`senpi app-server listening on unix://${unix.socketPath}\n`);
			if (unix.tokenFile) {
				process.stderr.write(`token ${unix.tokenFile}\n`);
			}
		}

		const reason = await shutdownSignal;
		await withShutdownDeadline(interruptActiveTurns(runtime), 5_000);
		await withShutdownDeadline(shutdownTransports({ stdio, unix, websocket, reason }), 5_000);
		process.exitCode = 0;
	} finally {
		runtime.dispose();
		process.off("SIGINT", handleSignal);
		process.off("SIGTERM", handleSignal);
	}
}

type AppServerRuntime = {
	readonly core: ServerCore;
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
	readonly turns: TurnEngineApi;
	readonly dispose: () => void;
};

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
	let lifecycle: ThreadLifecycleController | undefined;
	const core = createRoutedServerCore(registry, notifications, approvals, (threadId) => {
		lifecycle?.scheduleIdleUnloadForThread(threadId);
	});
	threads = new ThreadRegistry({
		agentDir: getAgentDir(),
		sessionDir: process.env[ENV_SESSION_DIR],
		createSession: (options) => createBoundAppServerSession(options, approvals, notifications, requestShutdown),
	});
	const turnLog = new TurnLog();
	const turns = createTurnEngine({
		store: createModeTurnStore(threads),
		turnLog,
		emitToThread: (threadId, notification) => notifications.toThread(threadId, notification),
		broadcast: (notification) => notifications.broadcast(notification),
	});
	registerTurnHandlers(registry, turns);

	lifecycle = registerThreadLifecycleHandlers(registry, {
		threads,
		turnLog,
		notifications,
		deferUntilResponded: (connectionId, action) => core.deferUntilResponded(connectionId, action),
		idleUnloadMinutes: 30,
		replayPendingApprovals: (threadId) => {
			approvals.replayPendingForThread(threadId);
		},
	});
	registerLoadedThreadObjectListHandler(registry, threads);

	return { core, threads, turnLog, turns, dispose: () => lifecycle?.dispose() };
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
	readonly unix: UnixSocketListenerHandle | undefined;
	readonly websocket: WebSocketListenerHandle | undefined;
	readonly reason: string;
}): Promise<void> {
	await options.stdio?.drain();
	await options.stdio?.close(options.reason);
	await options.unix?.close();
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
