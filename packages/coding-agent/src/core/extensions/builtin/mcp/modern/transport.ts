import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { deriveModernHeaders, MODERN_PROTOCOL_VERSION, type ModernClientInfo, modernizeRequest } from "./wire.ts";

export type ModernHttpTransportOptions = {
	readonly url: string | URL;
	readonly fetch: FetchLike;
	readonly clientInfo: ModernClientInfo;
	readonly clientCapabilities: Readonly<Record<string, unknown>>;
	readonly protocolVersion?: string;
	readonly headers?: RequestInit["headers"];
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
		try {
			const version = this.#options.protocolVersion ?? MODERN_PROTOCOL_VERSION;
			const headers = new Headers(this.#options.headers);
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
			const response = await this.#options.fetch(this.#options.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: this.#abort.signal,
			});
			this.#abort.signal.throwIfAborted();
			if (response.status === 202 || response.status === 204) return;
			const mediaType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
			if (mediaType === "application/json") {
				const incoming = JSONRPCMessageSchema.parse(await response.json());
				// Protocol errors (including modern negotiation errors on HTTP 400) stay on the RPC channel.
				if (!response.ok && !("error" in incoming)) {
					throw new ModernTransportError(`Modern MCP POST failed with HTTP ${response.status}`);
				}
				this.#abort.signal.throwIfAborted();
				this.onmessage?.(incoming);
			} else if (response.ok && mediaType === "text/event-stream" && response.body) {
				await this.#consumeSse(response.body, "method" in message && "id" in message ? message.id : undefined);
			} else {
				throw new ModernTransportError(
					`Modern MCP POST failed with HTTP ${response.status} (${mediaType ?? "no content type"})`,
				);
			}
		} catch (error) {
			const failure = error instanceof Error ? error : new ModernTransportError(String(error));
			this.onerror?.(failure);
			throw failure;
		}
	}

	async #consumeSse(stream: ReadableStream<Uint8Array>, requestId: string | number | undefined): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const aborted = Promise.withResolvers<never>();
		const onabort = () => aborted.reject(this.#abort.signal.reason);
		this.#abort.signal.addEventListener("abort", onabort, { once: true });
		let buffer = "";
		let data: string[] = [];
		let event = "";
		try {
			while (true) {
				const { value, done } = await Promise.race([reader.read(), aborted.promise]);
				this.#abort.signal.throwIfAborted();
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
							this.onmessage?.(incoming);
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
			this.#abort.signal.removeEventListener("abort", onabort);
			await reader.cancel();
			reader.releaseLock();
		}
	}
}
