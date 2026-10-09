import { isMainThread, MessageChannel, type MessagePort } from "node:worker_threads";
import { mainThreadWebViewService } from "./webview-service.ts";

export interface WebViewServiceConnection {
	readonly clientId: string;
	/** Transfer this into the kernel worker; it is the only handle to the client's views. */
	readonly port: MessagePort;
	/** Closes every view created through `port`; afterwards the port is dead. */
	release(): Promise<void>;
}

export interface WebViewBroker {
	/** Hand this to exactly one worker thread (workerData + transferList). */
	readonly port: MessagePort;
	dispose(): Promise<void>;
}

type BrokerRequest =
	| { readonly kind: "connect"; readonly id: number }
	| { readonly kind: "release"; readonly id: number; readonly clientId: string };
type BrokerReply =
	| { readonly kind: "connected"; readonly id: number; readonly clientId: string; readonly port: MessagePort }
	| { readonly kind: "released"; readonly id: number }
	| { readonly kind: "failed"; readonly id: number; readonly message: string };

const BROKER_KEY = Symbol.for("senpi.webview.broker");

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function parseBrokerRequest(value: unknown): BrokerRequest | undefined {
	if (!isRecord(value) || typeof value.id !== "number") return undefined;
	if (value.kind === "connect") return { kind: "connect", id: value.id };
	if (value.kind === "release" && typeof value.clientId === "string") {
		return { kind: "release", id: value.id, clientId: value.clientId };
	}
	return undefined;
}

/**
 * Main-thread side of one worker thread's route to the WebView service (RPC session workers run the
 * eval kernel host off the main thread). Clients connected through a broker belong to it: it can
 * release only those, and they are all released when the worker exits or the broker is disposed.
 */
export function createWebViewBroker(): WebViewBroker | undefined {
	const service = mainThreadWebViewService();
	if (!service) return undefined;
	const owner = {};
	const channel = new MessageChannel();
	const local = channel.port1;
	const reply = (message: BrokerReply, transfer: MessagePort[] = []): void => local.postMessage(message, transfer);
	local.on("message", async (value: unknown) => {
		const request = parseBrokerRequest(value);
		if (!request) return;
		try {
			if (request.kind === "connect") {
				const grant = service.connect(owner);
				reply({ kind: "connected", id: request.id, clientId: grant.clientId, port: grant.port }, [grant.port]);
			} else {
				await service.release(request.clientId, owner);
				reply({ kind: "released", id: request.id });
			}
		} catch (error) {
			reply({ kind: "failed", id: request.id, message: error instanceof Error ? error.message : String(error) });
		}
	});
	local.on("close", () => void service.releaseOwner(owner));
	local.unref();
	return {
		port: channel.port2,
		dispose: async () => {
			local.close();
			await service.releaseOwner(owner);
		},
	};
}

class WorkerBrokerClient {
	readonly #port: MessagePort;
	readonly #pending = new Map<number, (reply: BrokerReply) => void>();
	#nextId = 1;

	constructor(port: MessagePort) {
		this.#port = port;
		port.on("message", (reply: BrokerReply) => {
			const settle = this.#pending.get(reply.id);
			this.#pending.delete(reply.id);
			settle?.(reply);
		});
		port.unref();
	}

	async connect(): Promise<WebViewServiceConnection> {
		const reply = await this.#request({ kind: "connect", id: this.#nextId++ });
		if (reply.kind !== "connected")
			throw new Error(reply.kind === "failed" ? reply.message : "unexpected broker reply");
		const clientId = reply.clientId;
		return {
			clientId,
			port: reply.port,
			release: async () => void (await this.#request({ kind: "release", id: this.#nextId++, clientId })),
		};
	}

	#request(request: BrokerRequest): Promise<BrokerReply> {
		return new Promise((resolve) => {
			this.#pending.set(request.id, resolve);
			this.#port.postMessage(request);
		});
	}
}

function isBrokerClient(value: unknown): value is WorkerBrokerClient {
	return value instanceof WorkerBrokerClient;
}

function isMessagePort(value: unknown): value is MessagePort {
	return isRecord(value) && typeof value.postMessage === "function" && typeof value.on === "function";
}

/** Worker-thread side: install the broker port the main thread passed in `workerData`. */
export function registerWebViewBroker(port: unknown): void {
	if (isMainThread || !isMessagePort(port)) return;
	Reflect.set(globalThis, BROKER_KEY, new WorkerBrokerClient(port));
}

/**
 * Connects an eval kernel to the main-thread WebView service: directly on the main thread, through
 * the thread's broker in a worker. Rejects when neither route exists (e.g. not running on Bun).
 */
export async function connectWebViewService(): Promise<WebViewServiceConnection> {
	if (isMainThread) {
		const service = mainThreadWebViewService();
		if (!service) throw new Error("Bun.WebView is not available in this runtime");
		const owner = {};
		const grant = service.connect(owner);
		return { ...grant, release: () => service.release(grant.clientId, owner) };
	}
	const broker: unknown = Reflect.get(globalThis, BROKER_KEY);
	if (!isBrokerClient(broker)) {
		throw new Error("no route from this worker thread to the main-thread WebView service");
	}
	return await broker.connect();
}
