import type { Readable } from "node:stream";
import { takeOverStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../../../core/output-guard.ts";
import type { ClassifiedIncoming, RpcEnvelope } from "../rpc/envelope.ts";
import { attachNdjsonRpcReader, type NdjsonRpcEmission, serializeNdjsonMessage } from "../rpc/ndjson.ts";
import type { Connection, ConnectionId, ConnectionInput } from "../server/connection.ts";

export interface StdioServerCore {
	addConnection(input: ConnectionInput): Connection;
	removeConnection(id: ConnectionId): void;
	receive(connectionId: ConnectionId, envelope: ClassifiedIncoming): Promise<void>;
}

export interface StdioTransportOptions {
	readonly core: StdioServerCore;
	readonly stdin?: Readable;
	readonly connectionId?: ConnectionId;
	readonly onShutdown?: (reason: string) => Promise<void> | void;
}

export interface StdioTransport {
	readonly connectionId: ConnectionId;
	drain(): Promise<void>;
	close(reason: string): Promise<void>;
}

const DEFAULT_CONNECTION_ID = "stdio";

let activeTransport: StdioTransportImpl | undefined;

export function startStdioTransport(options: StdioTransportOptions): StdioTransport {
	if (activeTransport) {
		throw new Error("stdio transport already active");
	}

	takeOverStdout();
	const transport = new StdioTransportImpl(options);
	activeTransport = transport;
	return transport;
}

class StdioTransportImpl implements StdioTransport {
	readonly connectionId: ConnectionId;
	private readonly core: StdioServerCore;
	private readonly stdin: Readable;
	private readonly onShutdown: ((reason: string) => Promise<void> | void) | undefined;
	private readonly connection: Connection;
	private readonly detachReader: () => void;
	private inputTail: Promise<void> = Promise.resolve();
	private closed = false;
	private shutdownRequested = false;

	private readonly handleStdinEnd = (): void => {
		this.requestShutdown("stdin ended");
	};

	private readonly handleStdinClose = (): void => {
		this.requestShutdown("stdin closed");
	};

	constructor(options: StdioTransportOptions) {
		this.core = options.core;
		this.stdin = options.stdin ?? process.stdin;
		this.connectionId = options.connectionId ?? DEFAULT_CONNECTION_ID;
		this.onShutdown = options.onShutdown;
		this.connection = this.core.addConnection({
			id: this.connectionId,
			transportKind: "stdio",
			send: (message) => this.writeMessage(message),
			close: (reason) => this.close(reason),
		});
		this.detachReader = attachNdjsonRpcReader(this.stdin, (message) => {
			this.enqueue(() => this.handleMessage(message));
		});
		this.stdin.on("end", this.handleStdinEnd);
		this.stdin.on("close", this.handleStdinClose);
	}

	async drain(): Promise<void> {
		await this.inputTail;
	}

	async close(reason: string): Promise<void> {
		this.closeCore(reason);
		await this.inputTail;
	}

	private enqueue(task: () => Promise<void>): void {
		const next = this.inputTail.then(task, task);
		this.inputTail = next.catch((error: unknown) => {
			this.reportError(error);
		});
	}

	private requestShutdown(reason: string): void {
		if (this.shutdownRequested) {
			return;
		}
		this.shutdownRequested = true;
		this.enqueue(async () => {
			this.closeCore(reason);
			await this.onShutdown?.(reason);
		});
	}

	private async handleMessage(message: NdjsonRpcEmission): Promise<void> {
		switch (message.kind) {
			case "parse-error":
				await this.connection.send(message.message);
				return;
			case "request":
			case "notification":
			case "response":
			case "protocol-invalid":
				await this.core.receive(this.connectionId, message);
				return;
			default:
				return assertNever(message);
		}
	}

	private async writeMessage(message: RpcEnvelope): Promise<void> {
		writeRawStdout(serializeNdjsonMessage(message));
		await waitForRawStdoutBackpressure();
	}

	private closeCore(reason: string): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.detachReader();
		this.stdin.off("end", this.handleStdinEnd);
		this.stdin.off("close", this.handleStdinClose);
		this.core.removeConnection(this.connectionId);
		if (activeTransport === this) {
			activeTransport = undefined;
		}
		process.stderr.write(`app-server stdio closed: ${reason}\n`);
	}

	private reportError(error: unknown): void {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		process.stderr.write(`app-server stdio error: ${message}\n`);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled stdio RPC emission: ${JSON.stringify(value)}`);
}
