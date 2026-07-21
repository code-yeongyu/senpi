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
import { type AppServerRuntime, createAppServerRuntime } from "./runtime.ts";
import { type StdioTransport, startStdioTransport } from "./transports/stdio.ts";
import { startAppServerUnixSocketListener, type UnixSocketListenerHandle } from "./transports/unix-socket.ts";
import {
	startAppServerWebSocketListener,
	type WebSocketListenerAuth,
	type WebSocketListenerHandle,
} from "./transports/websocket.ts";

export { runAppServerDaemonCommand } from "./daemon.ts";
export { createAppServerRuntime } from "./runtime.ts";
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
