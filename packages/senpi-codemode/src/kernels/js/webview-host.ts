import type { MessagePort } from "node:worker_threads";
import type { WebViewServiceConnection } from "@code-yeongyu/senpi";
import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { bridgeError } from "./worker-host.ts";

export type WebViewConnector = () => Promise<WebViewServiceConnection>;

// Loaded on the first WebView a cell asks for, so starting a kernel never pays for the host barrel.
const connectThroughHost: WebViewConnector = async () => (await import("@code-yeongyu/senpi")).connectWebViewService();

/**
 * The WebView clients one worker generation asked for. Chrome-backed `Bun.WebView`s only run on the
 * process main thread, so the worker gets a private port to the main-thread service; retiring the
 * generation (reset, close, crash, timeout) releases every view created through those ports.
 */
export class KernelWebViewClients {
	readonly #post: (message: HostToKernelMessage, transfer: readonly MessagePort[]) => void;
	readonly #connect: WebViewConnector;
	readonly #connections = new Set<WebViewServiceConnection>();
	#retired = false;

	constructor(
		post: (message: HostToKernelMessage, transfer: readonly MessagePort[]) => void,
		connect: WebViewConnector = connectThroughHost,
	) {
		this.#post = post;
		this.#connect = connect;
	}

	consume(message: KernelToHostMessage): boolean {
		if (message.type !== "webview-connect") return false;
		void this.#grant(message.requestId);
		return true;
	}

	async release(): Promise<void> {
		this.#retired = true;
		const connections = [...this.#connections];
		this.#connections.clear();
		await Promise.allSettled(connections.map((connection) => connection.release()));
	}

	async #grant(requestId: string): Promise<void> {
		let connection: WebViewServiceConnection;
		try {
			connection = await this.#connect();
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			if (!this.#retired) this.#post({ type: "webview-port", requestId, ok: false, error: bridgeError(cause) }, []);
			return;
		}
		if (this.#retired) {
			await connection.release();
			return;
		}
		this.#connections.add(connection);
		this.#post({ type: "webview-port", requestId, ok: true, port: connection.port }, [connection.port]);
	}
}
