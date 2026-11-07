import { PassThrough } from "node:stream";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ConnectError } from "./errors.ts";
import type { McpStdioTransportSpec } from "./transport-sdk.ts";

/**
 * A project transport resolves again at EVERY spawn, including an era probe's
 * fallback restart of the same transport object. SDK private spawn parameters
 * are never mutated; each start owns a newly constructed SDK transport.
 */
export class ProjectStdioTransport implements Transport {
	onmessage?: Transport["onmessage"];
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];
	readonly stderr = new PassThrough();
	readonly #resolve: () => Promise<McpStdioTransportSpec>;
	readonly #create: (spec: McpStdioTransportSpec) => StdioClientTransport;
	#current: StdioClientTransport | undefined;
	#epoch = 0;
	constructor(
		resolve: () => Promise<McpStdioTransportSpec>,
		create: (spec: McpStdioTransportSpec) => StdioClientTransport,
	) {
		this.#resolve = resolve;
		this.#create = create;
	}
	get pid(): number | null {
		return this.#current?.pid ?? null;
	}
	async start(): Promise<void> {
		const epoch = this.#epoch;
		const spec = await this.#resolve();
		if (epoch !== this.#epoch)
			throw new ConnectError("Project MCP spawn was invalidated; retry", {
				phase: "create",
				retriable: true,
			});
		const transport = this.#create(spec);
		this.#current = transport;
		transport.onmessage = (message: JSONRPCMessage) => this.onmessage?.(message);
		transport.onclose = () => this.onclose?.();
		transport.onerror = (error) => this.onerror?.(error);
		transport.stderr?.pipe(this.stderr, { end: false });
		await transport.start();
		if (epoch !== this.#epoch) {
			await transport.close();
			throw new ConnectError("Project MCP spawn was invalidated; retry", { phase: "create", retriable: true });
		}
	}
	async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
		if (this.#current === undefined)
			throw new ConnectError("Project MCP transport has not started", {
				phase: "send",
				retriable: true,
			});
		// The stdio SDK transport takes only the message; send options are an HTTP concern.
		await this.#current.send(message);
	}
	async close(): Promise<void> {
		this.#epoch++;
		await this.#current?.close();
	}
}
