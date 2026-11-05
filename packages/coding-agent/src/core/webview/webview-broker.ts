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
	| { readonly kind: "connect"; readonly id: number; readonly scope?: string }
	| { readonly kind: "release"; readonly id: number; readonly clientId: string; readonly scope?: string }
	| { readonly kind: "release-scope"; readonly id: number; readonly scope: string };
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
	const scope = typeof value.scope === "string" ? { scope: value.scope } : {};
	if (value.kind === "connect") return { kind: "connect", id: value.id, ...scope };
	if (value.kind === "release" && typeof value.clientId === "string") {
		return { kind: "release", id: value.id, clientId: value.clientId, ...scope };
	}
	if (value.kind === "release-scope" && typeof value.scope === "string") {
		return { kind: "release-scope", id: value.id, scope: value.scope };
	}
	return undefined;
}

/**
 * One owner per execution scope (senpi brain/hand S16e): the clients a scope connected are released only
 * through that scope's owner, so one scope can neither release nor outlive the end of another's views.
 * A connection with no scope keeps the caller's unscoped owner, exactly as before scopes existed.
 */
class ScopeOwners {
	readonly #owners = new Map<string, object>();

	for(scope: string): object {
		const existing = this.#owners.get(scope);
		if (existing) return existing;
		const owner = {};
		this.#owners.set(scope, owner);
		return owner;
	}

	take(scope: string): object | undefined {
		const owner = this.#owners.get(scope);
		this.#owners.delete(scope);
		return owner;
	}

	takeAll(): object[] {
		const owners = [...this.#owners.values()];
		this.#owners.clear();
		return owners;
	}
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
	const scopes = new ScopeOwners();
	const ownerOf = (scope: string | undefined): object => (scope === undefined ? owner : scopes.for(scope));
	const releaseAll = async (): Promise<void> => {
		await Promise.all([owner, ...scopes.takeAll()].map((each) => service.releaseOwner(each)));
	};
	const channel = new MessageChannel();
	const local = channel.port1;
	const reply = (message: BrokerReply, transfer: MessagePort[] = []): void => local.postMessage(message, transfer);
	local.on("message", async (value: unknown) => {
		const request = parseBrokerRequest(value);
		if (!request) return;
		try {
			if (request.kind === "connect") {
				const grant = service.connect(ownerOf(request.scope));
				reply({ kind: "connected", id: request.id, clientId: grant.clientId, port: grant.port }, [grant.port]);
			} else if (request.kind === "release") {
				await service.release(request.clientId, ownerOf(request.scope));
				reply({ kind: "released", id: request.id });
			} else {
				const scopeOwner = scopes.take(request.scope);
				if (scopeOwner) await service.releaseOwner(scopeOwner);
				reply({ kind: "released", id: request.id });
			}
		} catch (error) {
			reply({ kind: "failed", id: request.id, message: error instanceof Error ? error.message : String(error) });
		}
	});
	local.on("close", () => void releaseAll());
	local.unref();
	return {
		port: channel.port2,
		dispose: async () => {
			local.close();
			await releaseAll();
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

	async connect(scope: string | undefined): Promise<WebViewServiceConnection> {
		const scoped = scope === undefined ? {} : { scope };
		const reply = await this.#request({ kind: "connect", id: this.#nextId++, ...scoped });
		if (reply.kind !== "connected")
			throw new Error(reply.kind === "failed" ? reply.message : "unexpected broker reply");
		const clientId = reply.clientId;
		return {
			clientId,
			port: reply.port,
			release: async () => void (await this.#request({ kind: "release", id: this.#nextId++, clientId, ...scoped })),
		};
	}

	async releaseScope(scope: string): Promise<void> {
		const reply = await this.#request({ kind: "release-scope", id: this.#nextId++, scope });
		if (reply.kind === "failed") throw new Error(reply.message);
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

const mainThreadScopes = new ScopeOwners();

function threadBroker(): WorkerBrokerClient {
	const broker: unknown = Reflect.get(globalThis, BROKER_KEY);
	if (!isBrokerClient(broker)) {
		throw new Error("no route from this worker thread to the main-thread WebView service");
	}
	return broker;
}

/**
 * Connects an eval kernel to the main-thread WebView service: directly on the main thread, through
 * the thread's broker in a worker. Rejects when neither route exists (e.g. not running on Bun).
 * With a `scope`, the client belongs to that execution scope and `releaseWebViewScope` ends it.
 */
export async function connectWebViewService(scope?: string): Promise<WebViewServiceConnection> {
	if (isMainThread) {
		const service = mainThreadWebViewService();
		if (!service) throw new Error("Bun.WebView is not available in this runtime");
		const owner = scope === undefined ? {} : mainThreadScopes.for(scope);
		const grant = service.connect(owner);
		return { ...grant, release: () => service.release(grant.clientId, owner) };
	}
	return await threadBroker().connect(scope);
}

/** Closes every view of one execution scope's clients on this thread's route; other scopes keep theirs. */
export async function releaseWebViewScope(scope: string): Promise<void> {
	if (!isMainThread) return await threadBroker().releaseScope(scope);
	const owner = mainThreadScopes.take(scope);
	const service = mainThreadWebViewService();
	if (owner && service) await service.releaseOwner(owner);
}
