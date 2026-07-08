import { inspect } from "node:util";
import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { JavaScriptKernelMode } from "./context-manager.ts";

type AsyncFunctionType = new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
const AsyncFunction = async function inlineAsyncFunction() {
	return undefined;
}.constructor as AsyncFunctionType;

export interface WorkerLike {
	readonly mode: JavaScriptKernelMode;
	postMessage(message: HostToKernelMessage): void;
	onMessage(handler: (message: KernelToHostMessage) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

export function createInlineWorker(parallelPoolWidth: number): WorkerLike {
	return new InlineWorker(parallelPoolWidth);
}

class InlineWorker implements WorkerLike {
	readonly mode = "inline";
	readonly #parallelPoolWidth: number;
	readonly #state: Record<string, unknown> = {};
	#handlers: Array<(message: KernelToHostMessage) => void> = [];
	#errorHandlers: Array<(error: Error) => void> = [];
	#pendingTools = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();

	constructor(parallelPoolWidth: number) {
		this.#parallelPoolWidth = parallelPoolWidth;
	}

	postMessage(message: HostToKernelMessage): void {
		if (message.type === "init") this.#emit({ type: "ready" });
		else if (message.type === "run") void this.#run(message.cellId, message.code);
		else if (message.type === "tool-reply") this.#deliverToolReply(message);
		else if (message.type === "close") this.#emit({ type: "closed" });
	}

	onMessage(handler: (message: KernelToHostMessage) => void): () => void {
		this.#handlers.push(handler);
		return () => {
			this.#handlers = this.#handlers.filter((existing) => existing !== handler);
		};
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.push(handler);
		return () => {
			this.#errorHandlers = this.#errorHandlers.filter((existing) => existing !== handler);
		};
	}

	async terminate(): Promise<void> {
		this.#handlers = [];
		this.#errorHandlers = [];
		this.#pendingTools.clear();
	}

	async #run(cellId: string, code: string): Promise<void> {
		const started = Date.now();
		try {
			const value = await this.#execute(code);
			this.#emit({
				type: "result",
				cellId,
				ok: true,
				valueRepr: valueRepr(value),
				durationMs: Date.now() - started,
			});
		} catch (error) {
			this.#emit({ type: "result", cellId, ok: false, error: bridgeError(error), durationMs: Date.now() - started });
		}
	}

	async #execute(code: string): Promise<unknown> {
		const transformed = code.replace(/(^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gu, "$1state.$2 =");
		const body = /\breturn\b/u.test(transformed) ? transformed : `return await (${transformed})`;
		const fn = new AsyncFunction(
			"state",
			"tool",
			"parallel",
			"print",
			"display",
			"log",
			"phase",
			`with (state) { ${body} }`,
		);
		return await fn(
			this.#state,
			this.#toolProxy(),
			this.#parallel.bind(this),
			this.#print.bind(this),
			this.#display.bind(this),
			this.#log.bind(this),
			this.#phase.bind(this),
		);
	}

	#toolProxy(): unknown {
		return new Proxy(
			{},
			{
				get: (_target, prop) => {
					if (typeof prop !== "string") return undefined;
					return async (args: unknown) => await this.#callTool(prop, args);
				},
			},
		);
	}

	async #callTool(toolName: string, args: unknown): Promise<unknown> {
		const callId = `js-${crypto.randomUUID()}`;
		const promise = new Promise<unknown>((resolve, reject) => this.#pendingTools.set(callId, { resolve, reject }));
		this.#emit({ type: "tool-call", callId, toolName, args });
		return await promise;
	}

	#deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		const pending = this.#pendingTools.get(message.callId);
		if (!pending) return;
		this.#pendingTools.delete(message.callId);
		if (message.ok) pending.resolve(message.value);
		else pending.reject(errorFromBridge(message.error));
	}

	async #parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]> {
		const results = new Array<unknown>(thunks.length);
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(this.#parallelPoolWidth, thunks.length) }, async () => {
				while (next < thunks.length) {
					const index = next;
					next += 1;
					results[index] = await thunks[index]();
				}
			}),
		);
		return results;
	}

	#print(...values: unknown[]): void {
		this.#emit({ type: "text", stream: "stdout", data: `${values.map(formatValue).join(" ")}\n` });
	}

	#display(value: unknown): void {
		this.#emit({
			type: "display",
			mimeType: "application/json",
			dataBase64: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
		});
	}

	#log(message: unknown): void {
		this.#emit({ type: "log", message: String(message) });
	}

	#phase(title: unknown): void {
		this.#emit({ type: "phase", title: String(title) });
	}

	#emit(message: KernelToHostMessage): void {
		for (const handler of this.#handlers) handler(message);
	}
}

function valueRepr(value: unknown): string | undefined {
	return value === undefined ? undefined : JSON.stringify(value);
}

function formatValue(value: unknown): string {
	return typeof value === "string" ? value : inspect(value, { colors: false, depth: 5 });
}

function errorFromBridge(error: { message: string; name?: string; stack?: string }): Error {
	const result = new Error(error.message);
	if (error.name) result.name = error.name;
	if (error.stack) result.stack = error.stack;
	return result;
}

function bridgeError(error: unknown): { message: string; name?: string; stack?: string } {
	if (error instanceof Error) return { message: error.message, name: error.name, stack: error.stack };
	return { message: String(error) };
}
