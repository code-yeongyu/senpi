// Vendored from https://github.com/earendil-works/pi (packages/codemode/src) at v1.0.1, commit a7229ddc21810d6245105978033b7df645ecc2f7.
// MIT license; see LICENSE beside this file. Local changes are listed in VENDORED.md.
import { Worker } from "node:worker_threads";
import { toCodemodeIdentifier } from "../identifier.ts";
import type {
	CodemodeOutputFrame, // senpi-change
	CodemodeCall,
	CodemodeCallStatus,
	CodemodeError,
	CodemodeExecuteOptions,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeSandboxOptions,
	CodemodeStoreWrites,
	CodemodeTool,
} from "../types.ts";
import { type CodemodeWasmModule, loadQuickJSWasm } from "../wasm.ts";
import {
	type HostToWorkerMessage,
	isWorkerToHostMessage,
	type WorkerData,
	type WorkerToHostMessage,
} from "./protocol.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_GLOBALS: ReadonlySet<string> = new Set([
	"tools",
	"ALL_TOOLS",
	"console",
	"text",
	"image",
	"exit",
	"globalThis",
	"store",
	"load",
]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serializeStore(store: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	const serialized: Record<string, string> = {};
	for (const [key, value] of Object.entries(store ?? {})) {
		const json = JSON.stringify(value);
		if (json !== undefined) serialized[key] = json;
	}
	return serialized;
}

function parseStoreWrites(json: string): CodemodeStoreWrites {
	const writes: CodemodeStoreWrites = { set: {}, delete: [] };
	for (const [key, value] of JSON.parse(json) as [string, string?][]) {
		if (value === undefined) writes.delete.push(key);
		else writes.set[key] = JSON.parse(value);
	}
	return writes;
}

function defaultWorkerUrl(): URL {
	// `.ts` when running from source (tests, tsx), `.js` from the published dist.
	return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

interface PendingCall {
	record: CodemodeCall | undefined;
	startedAt: number;
	controller: AbortController;
}

interface ExecutionOptions {
	code: string;
	tools: ReadonlyMap<string, CodemodeTool>;
	globals: ReadonlyMap<string, CodemodeTool>;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	memoryLimitBytes: number | undefined;
	store: Record<string, string>;
	wasm: Promise<CodemodeWasmModule>;
	workerUrl: string | URL;
	// senpi-change begin: output streaming and builtin policy
	stream: StreamOptions | undefined;
	storePolicy: "collect" | "reject";
	// senpi-change end
}
// senpi-change begin: output streaming
interface StreamOptions {
	onOutputFrame: (frame: CodemodeOutputFrame) => void | Promise<void>;
	windowBytes: number;
	frameBytes: number;
}

const DEFAULT_WINDOW_BYTES = 256 * 1024;
const DEFAULT_FRAME_BYTES = 64 * 1024;
// senpi-change end

/**
 * One script run in its own worker and QuickJS VM. A fresh worker per run keeps
 * termination simple: a runaway script, including one that only spins the
 * microtask queue, is killed with `terminate()` and cannot poison a later run.
 */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private resolveResult!: (result: CodemodeResult) => void;
	private worker: Worker | undefined;
	private readonly interrupt = new SharedArrayBuffer(4);
	private readonly tools: ReadonlyMap<string, CodemodeTool>;
	private readonly globals: ReadonlyMap<string, CodemodeTool>;
	private readonly signal: AbortSignal | undefined;
	private readonly timer: NodeJS.Timeout | undefined;
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	private finished = false;
	// senpi-change begin: output streaming
	private readonly stream: StreamOptions | undefined;
	private readonly credits: Int32Array | undefined;
	private frameChain: Promise<void> = Promise.resolve();
	private frames = 0;
	private inFlightBytes = 0;
	private maxInFlightBytes = 0;
	private frameFailure: string | undefined;
	/** Set when an abort or timeout settles the run: frames still queued are dropped, never handed over. */
	private abandoned = false;
	private abandonDrain: ((late: CodemodeError) => void) | undefined;
	// senpi-change end

	constructor(options: ExecutionOptions) {
		this.promise = new Promise<CodemodeResult>((resolve) => {
			this.resolveResult = resolve;
		});
		this.tools = options.tools;
		this.globals = options.globals;
		this.signal = options.signal;
		// senpi-change begin: output streaming
		this.stream = options.stream;
		if (options.stream !== undefined) {
			this.credits = new Int32Array(new SharedArrayBuffer(4));
			Atomics.store(this.credits, 0, options.stream.windowBytes);
		}
		// senpi-change end

		if (Number.isFinite(options.timeoutMs)) {
			this.timer = setTimeout(() => {
				this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeoutMs} ms` });
			}, options.timeoutMs);
		}

		if (options.signal) {
			if (options.signal.aborted) {
				this.onAbort();
			} else {
				options.signal.addEventListener("abort", this.onAbort, { once: true });
			}
		}

		options.wasm.then(
			(wasm) => this.start(options, wasm),
			(error: unknown) => {
				this.finish({ kind: "sandbox", message: `Failed to load QuickJS: ${errorMessage(error)}` });
			},
		);
	}

	abort(message: string): Promise<CodemodeResult> {
		this.finish({ kind: "aborted", message });
		return this.promise;
	}

	private start(options: ExecutionOptions, wasm: CodemodeWasmModule): void {
		if (this.finished) return;
		const workerData: WorkerData = {
			code: options.code,
			tools: [...options.tools.values()].map((tool) => ({
				name: tool.name,
				jsName: toCodemodeIdentifier(tool.name),
				description: tool.description ?? "",
			})),
			globals: [...options.globals.values()].map((global) => ({
				name: global.name,
				spread: global.spread === true,
			})),
			wasm,
			memoryLimitBytes: options.memoryLimitBytes,
			store: options.store,
			interrupt: this.interrupt,
			// senpi-change begin: output streaming and builtin policy
			...(this.credits === undefined || this.stream === undefined
				? {}
				: { stream: { credits: this.credits.buffer as SharedArrayBuffer, frameBytes: this.stream.frameBytes } }),
			storePolicy: options.storePolicy,
			// senpi-change end
		};
		let worker: Worker;
		try {
			worker = new Worker(options.workerUrl, { workerData });
		} catch (error) {
			this.finish({ kind: "sandbox", message: `Failed to start worker: ${errorMessage(error)}` });
			return;
		}
		this.worker = worker;
		worker.on("message", (message: unknown) => this.handleMessage(message));
		worker.on("error", (error: unknown) => {
			this.finish({
				kind: "sandbox",
				name: error instanceof Error ? error.name : undefined,
				message: errorMessage(error),
			});
		});
		worker.on("exit", (code) => {
			this.finish({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` });
		});
	}

	private readonly onAbort = (): void => {
		const reason: unknown = this.signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	private post(message: HostToWorkerMessage): void {
		this.worker?.postMessage(message);
	}

	private handleMessage(message: unknown): void {
		if (this.finished || !isWorkerToHostMessage(message)) return;
		switch (message.type) {
			case "output":
				this.output.push(message.item);
				break;
			// senpi-change begin: output streaming
			case "output-frame":
				this.enqueueFrame(message.frame, message.bytes);
				break;
			// senpi-change end
			case "call":
				void this.handleCall(message);
				break;
			case "done":
				this.handleDone(message);
				break;
			case "crash":
				this.finish({ kind: "sandbox", message: message.message });
				break;
		}
	}

	private handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
		if (!message.ok) {
			const parsed = JSON.parse(message.error) as Omit<CodemodeError, "kind">;
			this.finish({ kind: "script", ...parsed });
			return;
		}
		this.finish(undefined, message.value === undefined ? undefined : JSON.parse(message.value), message.writes);
	}

	private async handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): Promise<void> {
		const { id, name } = message;
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool ? { name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(id, pending);

		let status: CodemodeCallStatus;
		let reply: HostToWorkerMessage;
		try {
			const tool = (isTool ? this.tools : this.globals).get(name);
			if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await tool.execute(args, { signal: pending.controller.signal });
			reply = { type: "result", id, ok: true, payload: value === undefined ? undefined : JSON.stringify(value) };
			status = "ok";
		} catch (error) {
			reply = { type: "result", id, ok: false, payload: errorMessage(error) };
			status = "error";
		}

		// Already cancelled by finish(): the record keeps "cancelled" and the
		// worker is gone or going.
		if (!this.pending.delete(id)) return;
		if (record) {
			record.status = status;
			record.durationMs = performance.now() - pending.startedAt;
		}
		this.post(reply);
	}
	// senpi-change begin: output streaming
	/**
	 * Hands frames to the consumer one at a time, in arrival order, and returns their credit only once consumed.
	 * The message loop never waits here: frames queue on the chain, and the worker cannot send past the window.
	 */
	private enqueueFrame(frame: CodemodeOutputFrame, bytes: number): void {
		const stream = this.stream;
		const credits = this.credits;
		if (stream === undefined || credits === undefined) return;
		this.inFlightBytes += bytes;
		this.maxInFlightBytes = Math.max(this.maxInFlightBytes, this.inFlightBytes);
		this.frameChain = this.frameChain
			.then(async () => {
				if (this.frameFailure === undefined && !this.abandoned) await stream.onOutputFrame(frame);
				this.frames++;
			})
			.catch((error: unknown) => {
				this.frameFailure ??= errorMessage(error);
				this.finish({ kind: "sandbox", message: `Output consumer failed: ${this.frameFailure}` });
			})
			.finally(() => {
				this.inFlightBytes -= bytes;
				Atomics.add(credits, 0, bytes);
				Atomics.notify(credits, 0);
			});
	}
	// senpi-change end

	private finish(error: CodemodeError | undefined, value?: unknown, writes?: string): void {
		// senpi-change begin: output streaming
		// A settled run whose last frames are still being consumed keeps its timer and abort listener armed:
		// a late abort, timeout or close() abandons those frames and settles the run, so a consumer that never
		// returns can't keep it alive.
		if (this.finished) {
			if (this.abandonDrain !== undefined && (error?.kind === "aborted" || error?.kind === "timeout")) {
				this.abandonDrain(error);
			}
			return;
		}
		this.finished = true;
		const abandon = error?.kind === "aborted" || error?.kind === "timeout";
		const draining = this.stream !== undefined && !abandon;
		if (!draining) {
			clearTimeout(this.timer);
			this.signal?.removeEventListener("abort", this.onAbort);
		}
		// senpi-change end

		const now = performance.now();
		for (const pending of this.pending.values()) {
			if (pending.record) pending.record.durationMs = now - pending.startedAt;
			pending.controller.abort();
		}
		this.pending.clear();

		const result: CodemodeResult = error
			? { ok: false, error, output: this.output, calls: this.calls }
			: {
					ok: true,
					value,
					output: this.output,
					calls: this.calls,
					storeWrites: writes === undefined ? { set: {}, delete: [] } : parseStoreWrites(writes),
				};
		// senpi-change begin: output streaming
		// Settle only after every frame that arrived has been consumed, so output precedes the result. An abort or
		// timeout settles at once instead, and one arriving while frames drain abandons them (see the top).
		if (abandon) this.abandoned = true;
		let lateResult: CodemodeResult | undefined;
		const abandoned = new Promise<void>((resolve) => {
			this.abandonDrain = (late) => {
				// Every frame that arrived was consumed: the run finished as it reports, and an abort changes nothing.
				if (this.inFlightBytes === 0) return;
				this.abandoned = true;
				lateResult = { ok: false, error: late, output: this.output, calls: this.calls };
				resolve();
			};
		});
		const afterFrames = (): Promise<void> => (abandon ? Promise.resolve() : Promise.race([this.frameChain, abandoned]));
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			this.abandonDrain = undefined;
			clearTimeout(this.timer);
			this.signal?.removeEventListener("abort", this.onAbort);
			// A consumer that failed while the last frames drained lost output, so the run cannot report success.
			const final =
				lateResult ??
				(this.frameFailure !== undefined && result.ok
					? {
							ok: false,
							error: { kind: "sandbox", message: `Output consumer failed: ${this.frameFailure}` },
							output: this.output,
							calls: this.calls,
						}
					: result);
			if (this.stream !== undefined) {
				final.streamed = {
					frames: this.frames,
					maxInFlightBytes: this.maxInFlightBytes,
					windowBytes: this.stream.windowBytes,
				};
			}
			this.resolveResult(final);
		};
		if (!this.worker) {
			void afterFrames().then(settle);
			return;
		}
		Atomics.store(new Int32Array(this.interrupt), 0, 1);
		// A worker sleeping on credits must wake to see the interrupt before terminate() can stop it.
		if (this.credits !== undefined) Atomics.notify(this.credits, 0);
		this.worker
			.terminate()
			.catch(() => undefined)
			.then(afterFrames)
			.then(settle);
		// senpi-change end
	}
}

/**
 * Runs JavaScript in a QuickJS VM (a separate wasm instance) inside a worker
 * thread. The script sees `tools.<name>(args)` for every registered tool, `ALL_TOOLS`,
 * the output helpers `text`, `image`, `exit`, and `console.*`, `store`/`load`, and the
 * configured globals; nothing else (no timers, `fetch`, `process`, `require`, modules).
 *
 * Each `execute()` gets its own worker and VM; the sandbox only holds the tool
 * table and defaults. `close()` aborts in-flight executions.
 */
export class CodemodeSandbox {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly globalsByName = new Map<string, CodemodeTool>();
	private readonly timeoutMs: number;
	private readonly memoryLimitBytes: number | undefined;
	private readonly wasm: CodemodeWasmModule | Promise<CodemodeWasmModule> | undefined;
	private readonly workerUrl: string | URL;
	private readonly running = new Set<Execution>();
	// senpi-change begin: output streaming and builtin policy
	private readonly stream: StreamOptions | undefined;
	private readonly storePolicy: "collect" | "reject";
	// senpi-change end
	private closed = false;

	constructor(options: CodemodeSandboxOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.memoryLimitBytes = options.memoryLimitBytes;
		this.wasm = options.wasm;
		this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
		// senpi-change begin: output streaming and builtin policy
		this.storePolicy = options.builtins?.store ?? "collect";
		if (options.output === "stream") {
			if (options.onOutputFrame === undefined) throw new Error('output: "stream" needs onOutputFrame');
			const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
			const frameBytes = Math.min(options.frameBytes ?? DEFAULT_FRAME_BYTES, windowBytes);
			// A frame must hold a whole surrogate pair (4 bytes), or the worker can't avoid splitting one.
			if (!(windowBytes >= 4 && frameBytes >= 4)) throw new Error("windowBytes and frameBytes must be at least 4");
			this.stream = { onOutputFrame: options.onOutputFrame, windowBytes, frameBytes };
		}
		// senpi-change end
		for (const tool of options.tools ?? []) this.registerTool(tool);
		const namespaces = new Set<string>();
		for (const global of options.globals ?? []) {
			const parts = global.name.split(".");
			if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(parts[0])) {
				throw new Error(`Invalid global name "${global.name}"`);
			}
			if (this.globalsByName.has(global.name)) throw new Error(`Global "${global.name}" is already registered`);
			if (parts.length === 2) namespaces.add(parts[0]);
			this.globalsByName.set(global.name, global);
		}
		for (const name of namespaces) {
			if (this.globalsByName.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
		}
	}

	/** Throws if a tool with the same name is already registered. */
	registerTool(tool: CodemodeTool): void {
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
	}

	unregisterTool(name: string): boolean {
		return this.toolsByName.delete(name);
	}

	get tools(): CodemodeTool[] {
		return [...this.toolsByName.values()];
	}

	get globals(): CodemodeTool[] {
		return [...this.globalsByName.values()];
	}

	/**
	 * `code` is an async function body: `return` and top-level `await` work.
	 * Never rejects for script failures; those come back as `{ ok: false }`.
	 * The script can use `store(key, value)` and `load(key)` on `options.store`.
	 */
	execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
		const execution = new Execution({
			code,
			tools: new Map(this.toolsByName),
			globals: this.globalsByName,
			timeoutMs: options.timeoutMs ?? this.timeoutMs,
			signal: options.signal,
			memoryLimitBytes: this.memoryLimitBytes,
			store: serializeStore(options.store),
			wasm: this.wasm === undefined ? loadQuickJSWasm() : Promise.resolve(this.wasm),
			workerUrl: this.workerUrl,
			// senpi-change begin: output streaming and builtin policy
			stream: this.stream,
			storePolicy: this.storePolicy,
			// senpi-change end
		});
		this.running.add(execution);
		return execution.promise.finally(() => this.running.delete(execution));
	}

	/** Aborts in-flight executions (they resolve with `kind: "aborted"`) and rejects new ones. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
	}
}
