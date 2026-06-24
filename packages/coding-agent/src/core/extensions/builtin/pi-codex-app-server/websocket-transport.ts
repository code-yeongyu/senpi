import { PiCodexAppServerRuntimeError } from "./runtime-errors.ts";

type WebSocketEventType = "open" | "error" | "close";
type WebSocketListener = () => void;

export interface PiCodexAppServerWebSocketLike {
	readonly readyState: number;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener, options?: { readonly once?: boolean }): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	close(code?: number, reason?: string): void;
}

export interface PiCodexAppServerWebSocketDependencies {
	createWebSocket?(url: string): PiCodexAppServerWebSocketLike;
}

export interface PiCodexAppServerWebSocketConnection {
	close(): Promise<void>;
	onUnexpectedClose(handler: (message: string) => void): void;
}

export function openWebSocketConnection(
	url: string,
	connectTimeoutMs: number,
	dependencies: PiCodexAppServerWebSocketDependencies,
): Promise<PiCodexAppServerWebSocketConnection> {
	if (url.trim().length === 0) {
		throw new PiCodexAppServerRuntimeError("websocket", "Websocket URL is required.");
	}

	return new Promise((resolve, reject) => {
		const socket = createRuntimeWebSocket(url, dependencies);
		const timeout = setTimeout(() => {
			cleanup();
			socket.close(1000, "connect_timeout");
			reject(
				new PiCodexAppServerRuntimeError("websocket", `WebSocket connect timeout after ${connectTimeoutMs}ms.`),
			);
		}, connectTimeoutMs);
		const cleanup = () => {
			clearTimeout(timeout);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
		};
		const onOpen = () => {
			cleanup();
			resolve({
				close: () => closeWebSocket(socket),
				onUnexpectedClose: (handler) => {
					socket.addEventListener("close", () => handler("WebSocket closed unexpectedly."));
					socket.addEventListener("error", () => handler("WebSocket failed after opening."));
				},
			});
		};
		const onError = () => {
			cleanup();
			reject(new PiCodexAppServerRuntimeError("websocket", "WebSocket connection failed."));
		};
		const onClose = () => {
			cleanup();
			reject(new PiCodexAppServerRuntimeError("websocket", "WebSocket closed before opening."));
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
	});
}

function createRuntimeWebSocket(
	url: string,
	dependencies: PiCodexAppServerWebSocketDependencies,
): PiCodexAppServerWebSocketLike {
	if (dependencies.createWebSocket) return dependencies.createWebSocket(url);
	const WebSocketConstructor = globalThis.WebSocket;
	if (!WebSocketConstructor) {
		throw new PiCodexAppServerRuntimeError("websocket", "WebSocket transport is unavailable in this runtime.");
	}
	return new WebSocketConstructor(url);
}

function closeWebSocket(socket: PiCodexAppServerWebSocketLike): Promise<void> {
	return new Promise((resolve) => {
		if (socket.readyState === 3) {
			resolve();
			return;
		}
		const timeout = setTimeout(resolve, 1000);
		socket.addEventListener(
			"close",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
		socket.close(1000, "runtime_shutdown");
	});
}
