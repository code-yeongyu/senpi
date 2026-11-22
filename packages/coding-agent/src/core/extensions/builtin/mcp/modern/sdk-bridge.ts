import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	type InitializeResult,
	InitializeResultSchema,
	type JSONRPCMessage,
	LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import type { DiscoveryResult } from "./era.ts";
import { ModernTransportError } from "./transport.ts";
import { ModernSubscriptions } from "./subscriptions.ts";

/** The SDK's local `initialize` answer, built from validated discovery; discovery must support the real wire version. */
export function modernInitializeResult(discovery: DiscoveryResult, wireVersion: string): InitializeResult {
	if (!discovery.supportedVersions.includes(wireVersion)) {
		throw new ModernTransportError(`Discovery does not support negotiated MCP version ${wireVersion}`);
	}
	return InitializeResultSchema.parse({
		protocolVersion: LATEST_PROTOCOL_VERSION,
		capabilities: discovery.capabilities,
		serverInfo: discovery._meta["io.modelcontextprotocol/serverInfo"],
		...(discovery.instructions === undefined ? {} : { instructions: discovery.instructions }),
	});
}

/** Modern results may carry `nextCursor: null`, which the SDK's list schemas reject. */
export function normalizeModernResult(message: JSONRPCMessage): JSONRPCMessage {
	if ("result" in message && message.result.nextCursor === null) delete message.result.nextCursor;
	return message;
}

/** Local SDK lifecycle dialect; the negotiated wire version belongs only to the underlying transport. */
export class ModernSdkBridge implements Transport {
	onmessage?: Transport["onmessage"];
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];
	readonly #transport: Transport;
	readonly #initializeResult;
	readonly #subscriptions: ModernSubscriptions;
	#initialized = false;

	constructor(transport: Transport, discovery: DiscoveryResult, wireVersion: string) {
		this.#initializeResult = modernInitializeResult(discovery, wireVersion);
		this.#transport = transport;
		this.#subscriptions = new ModernSubscriptions(transport.send.bind(transport), discovery.capabilities, true);
	}

	async start(): Promise<void> {
		this.#transport.onmessage = (message, extra) => {
			if (this.#subscriptions.incoming(message)) this.onmessage?.(normalizeModernResult(message), extra);
		};
		this.#transport.onclose = () => {
			this.#subscriptions.dispose();
			this.onclose?.();
		};
		this.#transport.onerror = (error) => this.onerror?.(error);
		await this.#transport.start();
	}

	async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
		if ("method" in message && message.method === "initialize") {
			if (!("id" in message) || this.#initialized) {
				throw new ModernTransportError("Modern MCP bridge has already initialized");
			}
			this.#initialized = true;
			this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: this.#initializeResult });
			return;
		}
		if ("method" in message && message.method === "notifications/initialized" && !("id" in message)) return;
		this.#subscriptions.outgoing(message);
		try {
			await this.#transport.send(message, options);
		} catch (error) {
			this.#subscriptions.failedSend(message);
			throw error;
		}
	}

	close(): Promise<void> {
		this.#subscriptions.dispose();
		return this.#transport.close();
	}
}
