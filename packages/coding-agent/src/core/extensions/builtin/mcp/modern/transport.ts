import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { deriveModernHeaders, MODERN_PROTOCOL_VERSION, type ModernClientInfo, modernizeRequest } from "./wire.ts";
import { AuthError } from "../errors.ts";
import type { McpLogger } from "../log.ts";
import { sanitizeModernMessage } from "./diagnostics.ts";
import { McpMrtrError } from "./errors.ts";
import { getModernDispatchGuard, modernDispatchGuard } from "./request.ts";
import {
	clearMcpParameterHeaders,
	ModernParameterHeaders,
	ParameterHeaderValidationError,
} from "./parameter-headers.ts";

export type ModernHttpTransportOptions = {
	readonly url: string | URL;
	readonly fetch: FetchLike;
	readonly clientInfo: ModernClientInfo;
	readonly clientCapabilities: Readonly<Record<string, unknown>>;
	readonly protocolVersion?: string;
	readonly headers?: RequestInit["headers"];
	readonly logger?: Pick<McpLogger, "warn">;
};

export class ModernTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModernTransportError";
	}
}

/** Stateless POST transport; discovery and era selection belong to the connection factory. */
export class ModernHttpTransport implements Transport {
	onmessage?: Transport["onmessage"];
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];

	readonly #options: ModernHttpTransportOptions;
	readonly #abort = new AbortController();
	readonly #attempts = new Map<string | number, AbortController>();
	readonly #toolLists = new Map<string | number, boolean>();
	readonly #parameterHeaders = new ModernParameterHeaders();
	#started = false;
	#closed = false;

	constructor(options: ModernHttpTransportOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		if (this.#started || this.#closed) throw new ModernTransportError("Modern MCP transport cannot be started twice");
		this.#started = true;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#abort.abort();
		this.onclose?.();
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.#started || this.#closed) throw new ModernTransportError("Modern MCP transport is not open");
		if ("method" in message && message.method === "notifications/cancelled") {
			const id = message.params?.requestId;
			if (typeof id === "string" || typeof id === "number") this.#attempts.get(id)?.abort();
			return;
		}
		const id = "method" in message && "id" in message ? message.id : undefined;
		if (id !== undefined && "method" in message && message.method === "tools/list") {
			this.#toolLists.set(id, message.params?.cursor === undefined);
		}
		const controller = new AbortController();
		if (id !== undefined) this.#attempts.set(id, controller);
		const signal = AbortSignal.any([this.#abort.signal, controller.signal]);
		try {
			const version = this.#options.protocolVersion ?? MODERN_PROTOCOL_VERSION;
			const headers = new Headers(this.#options.headers);
			clearMcpParameterHeaders(headers);
			// Auth headers pass through, but protocol routing is exclusively derived from the body.
			for (const name of ["Mcp-Session-Id", "Mcp-Name", "Mcp-Method", "MCP-Protocol-Version"]) headers.delete(name);
			headers.set("Content-Type", "application/json");
			headers.set("Accept", "application/json, text/event-stream");
			let body: JSONRPCMessage = message;
			if ("method" in message) {
				const request = modernizeRequest(
					"id" in message ? message.id : 0,
					message.method,
					this.#options.clientInfo,
					this.#options.clientCapabilities,
					version,
					message.params,
				);
				for (const [name, value] of Object.entries(deriveModernHeaders(request))) headers.set(name, value);
				if (request.method === "tools/call") {
					this.#parameterHeaders.append(headers, request.params.name, request.params.arguments);
				}
				if ("id" in message) {
					body = request;
				} else {
					const { id: _id, ...notification } = request;
					body = notification;
				}
			} else {
				// JSON-RPC replies have no method or params; do not turn them into requests.
				headers.set("MCP-Protocol-Version", version);
			}
			const guard = "method" in message ? getModernDispatchGuard(message.params) : undefined;
			guard?.();
			const init: RequestInit & { [modernDispatchGuard]?: (credential?: string) => void } = {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
				[modernDispatchGuard]: guard,
			};
			const response = await this.#options.fetch(this.#options.url, init);
			signal.throwIfAborted();
			if (response.status === 401 || response.status === 403) {
				await response.body?.cancel();
				throw new AuthError("MCP server needs authentication; use /mcp auth-start.", {
					phase: "auth",
					retriable: false,
				});
			}
			if (response.status === 202 || response.status === 204) return;
			const mediaType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
			if (mediaType === "application/json") {
				const incoming = JSONRPCMessageSchema.parse(await response.json());
				// Protocol errors (including modern negotiation errors on HTTP 400) stay on the RPC channel.
				if (!response.ok && !("error" in incoming)) {
					throw new ModernTransportError(`Modern MCP POST failed with HTTP ${response.status}`);
				}
				signal.throwIfAborted();
				this.#deliver(incoming, id);
			} else if (response.ok && mediaType === "text/event-stream" && response.body) {
				await this.#consumeSse(response.body, id, signal);
			} else {
				throw new ModernTransportError(
					`Modern MCP POST failed with HTTP ${response.status} (${mediaType ?? "no content type"})`,
				);
			}
		} catch (error) {
			if (error instanceof ParameterHeaderValidationError) throw error;
			const failure =
				error instanceof McpMrtrError || error instanceof AuthError
					? error
					: new McpMrtrError("MCP_MRTR_TRANSPORT_FAILED");
			this.onerror?.(failure);
			throw failure;
		} finally {
			if (id !== undefined) this.#attempts.delete(id);
			if (id !== undefined) this.#toolLists.delete(id);
		}
	}

	#deliver(incoming: JSONRPCMessage, expected: string | number | undefined): void {
		if ("id" in incoming && (expected === undefined || incoming.id !== expected))
			throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
		if ("id" in incoming && "result" in incoming && this.#toolLists.has(incoming.id)) {
			const result = incoming.result;
			if (Array.isArray(result.tools)) {
				incoming = {
					...incoming,
					result: {
						...result,
						tools: this.#parameterHeaders.filterTools(
							result.tools,
							this.#toolLists.get(incoming.id) === true,
							(message) => this.#options.logger?.warn(message),
						),
					},
				};
			}
		}
		const safe = sanitizeModernMessage(incoming);
		if (safe) this.onmessage?.(safe);
	}

	async #consumeSse(
		stream: ReadableStream<Uint8Array>,
		requestId: string | number | undefined,
		signal: AbortSignal,
	): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const aborted = Promise.withResolvers<never>();
		const onabort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onabort, { once: true });
		if (signal.aborted) onabort();
		let buffer = "";
		let data: string[] = [];
		let event = "";
		try {
			while (true) {
				const { value, done } = await Promise.race([reader.read(), aborted.promise]);
				signal.throwIfAborted();
				buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
				while (true) {
					const match = /[\r\n]/.exec(buffer);
					if (match === null) break;
					const end = match.index;
					// A CR at the chunk boundary might still be followed by LF.
					if (!done && buffer[end] === "\r" && end + 1 === buffer.length) break;
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + (buffer.slice(end, end + 2) === "\r\n" ? 2 : 1));
					if (line === "") {
						if (data.length > 0 && (event === "" || event === "message")) {
							const incoming = JSONRPCMessageSchema.parse(JSON.parse(data.join("\n")));
							this.#deliver(incoming, requestId);
							if ("id" in incoming && !("method" in incoming) && incoming.id === requestId) return;
						}
						data = [];
						event = "";
					} else if (!line.startsWith(":")) {
						const colon = line.indexOf(":");
						const field = colon === -1 ? line : line.slice(0, colon);
						const text = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
						if (field === "data") data.push(text);
						if (field === "event") event = text;
					}
				}
				if (done) {
					if (requestId !== undefined)
						throw new ModernTransportError("Modern MCP SSE ended before the request response");
					return;
				}
			}
		} finally {
			signal.removeEventListener("abort", onabort);
			await reader.cancel();
			reader.releaseLock();
		}
	}
}
