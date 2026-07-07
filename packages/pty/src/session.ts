import { Buffer } from "node:buffer";
import process from "node:process";
import { loadNativePty, type NativePtyLoadResult, type NativePtyUnavailableDiagnostic } from "./native-loader.ts";
import { PipeFallbackSession, shouldUsePipeFallback } from "./pipe-fallback.ts";
import {
	exitedOperation,
	normalizeOperationResult,
	normalizeTerminalExit,
	notStartedOperation,
} from "./session-exit.ts";
import { getNativeSessionFactory } from "./session-native.ts";
import { defaultCommand, normalizeRawTailBytes, toNativeOptions, toPipeFallbackOptions } from "./session-options.ts";
import type {
	CreateNativeTerminalSession,
	TerminalSessionBackend,
	TerminalSessionDataHandler,
	TerminalSessionDependencies,
	TerminalSessionExit,
	TerminalSessionExitState,
	TerminalSessionHandle,
	TerminalSessionOperationResult,
	TerminalSessionOptions,
	TerminalSessionSignal,
} from "./session-types.ts";

export type {
	CreateNativeTerminalSession,
	TerminalSessionBackend,
	TerminalSessionDataHandler,
	TerminalSessionDependencies,
	TerminalSessionExit,
	TerminalSessionExitError,
	TerminalSessionExitState,
	TerminalSessionHandle,
	TerminalSessionNativeOptions,
	TerminalSessionOperationResult,
	TerminalSessionOptions,
	TerminalSessionSignal,
} from "./session-types.ts";

export class TerminalSession {
	readonly options: TerminalSessionOptions;
	private readonly nativeLoadResult: NativePtyLoadResult;
	private readonly createNativeSessionDependency?: CreateNativeTerminalSession;
	private readonly env: Readonly<Record<string, string | undefined>>;
	private readonly rawTailLimit: number;
	private readonly dataHandlers = new Set<TerminalSessionDataHandler>();
	private readonly exitHandlers = new Set<() => void>();
	private backendHandle: TerminalSessionHandle | null = null;
	private backendValue: TerminalSessionBackend | null = null;
	private exitPromise: Promise<TerminalSessionExit> | null = null;
	private settledExit: TerminalSessionExit | null = null;
	private rawTailBuffer = Buffer.alloc(0);
	private rawByteCount = 0;
	private killRequested = false;
	private unsubscribeBackendData: (() => void) | null = null;

	constructor(options: TerminalSessionOptions = {}, dependencies: TerminalSessionDependencies = {}) {
		this.options = {
			...options,
			args: options.args ? [...options.args] : undefined,
			env: options.env ? { ...options.env } : undefined,
		};
		this.nativeLoadResult = dependencies.nativeLoadResult ?? loadNativePty();
		this.createNativeSessionDependency = dependencies.createNativeSession;
		this.env = dependencies.env ?? process.env;
		this.rawTailLimit = normalizeRawTailBytes(options.rawTailBytes);
	}

	get native(): NativePtyLoadResult {
		return this.nativeLoadResult;
	}

	get unavailableDiagnostic(): NativePtyUnavailableDiagnostic | null {
		if (this.nativeLoadResult.native !== null) return null;
		return this.nativeLoadResult.diagnostic;
	}

	get backend(): TerminalSessionBackend | null {
		return this.backendValue;
	}

	get command(): string {
		return this.options.command ?? defaultCommand();
	}

	get status(): "not_started" | "running" | "exited" {
		return this.exitState.status;
	}

	get exited(): boolean {
		return this.settledExit !== null;
	}

	get isExited(): boolean {
		return this.exited;
	}

	get exitResult(): TerminalSessionExit | null {
		return this.settledExit;
	}

	get rawTail(): Buffer {
		return Buffer.from(this.rawTailBuffer);
	}

	get rawOutputBytes(): number {
		return this.rawByteCount;
	}

	get exitState(): TerminalSessionExitState {
		if (this.settledExit !== null) return { status: "exited", exit: this.settledExit };
		return { status: this.backendHandle === null ? "not_started" : "running", exit: null };
	}

	start(): this {
		if (this.settledExit !== null) throw new Error("Cannot restart exited terminal session");
		if (this.backendHandle !== null) throw new Error("Terminal session has already been started");

		const nativeFactory = this.createNativeSessionDependency ?? getNativeSessionFactory(this.nativeLoadResult);
		if (nativeFactory && !shouldUsePipeFallback(this.nativeLoadResult, this.env)) {
			this.backendValue = "native";
			this.backendHandle = nativeFactory(toNativeOptions(this.options), (chunk) => this.emitData(chunk));
		} else {
			this.backendValue = "pipe-fallback";
			const fallback = new PipeFallbackSession(toPipeFallbackOptions(this.options));
			this.backendHandle = fallback;
			this.unsubscribeBackendData = fallback.onData((chunk) => this.emitData(chunk));
			fallback.start();
		}

		const backendHandle = this.backendHandle;
		const backendValue = this.backendValue;
		if (backendHandle === null || backendValue === null) {
			throw new Error("Terminal session backend did not initialize");
		}

		if (backendValue === "native" && backendHandle.onData) {
			this.unsubscribeBackendData = backendHandle.onData((chunk) => this.emitData(chunk));
		}
		this.exitPromise = this.waitBackendExit(backendHandle, backendValue).then((exit) => this.settleExit(exit));
		return this;
	}

	onData(handler: TerminalSessionDataHandler): () => void {
		this.dataHandlers.add(handler);
		return () => this.dataHandlers.delete(handler);
	}

	onExit(handler: () => void): () => void {
		if (this.settledExit !== null) queueMicrotask(handler);
		else this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	write(data: string | Uint8Array): TerminalSessionOperationResult {
		const handle = this.backendHandle;
		if (this.settledExit !== null) return exitedOperation("write");
		if (handle === null) return notStartedOperation("write");
		return normalizeOperationResult(handle.write(data), "Wrote data to terminal session.");
	}

	resize(cols: number, rows: number): TerminalSessionOperationResult {
		const handle = this.backendHandle;
		if (this.settledExit !== null) return exitedOperation("resize");
		if (handle === null) return notStartedOperation("resize");
		return normalizeOperationResult(handle.resize(cols, rows), `Resized terminal session to ${cols}x${rows}.`);
	}

	kill(signal: TerminalSessionSignal = "SIGTERM"): TerminalSessionOperationResult {
		const handle = this.backendHandle;
		if (this.killRequested || this.settledExit !== null) {
			return {
				ok: true,
				idempotent: true,
				note: "Terminal session kill was already requested.",
			};
		}
		if (handle === null) return notStartedOperation("kill");

		this.killRequested = true;
		const result = normalizeOperationResult(handle.kill(signal), `Sent ${signal} to terminal session.`);
		if (!result.ok) this.killRequested = false;
		return result;
	}

	stop(): TerminalSessionOperationResult {
		return this.kill();
	}

	async waitExit(): Promise<TerminalSessionExit> {
		if (this.settledExit !== null) return this.settledExit;
		if (this.exitPromise === null) throw new Error("Cannot wait for terminal session exit before start");
		return await this.exitPromise;
	}

	private async waitBackendExit(
		handle: TerminalSessionHandle,
		backend: TerminalSessionBackend,
	): Promise<TerminalSessionExit> {
		const wait = handle.waitExit ?? handle.wait;
		if (!wait) throw new Error("Terminal session backend does not expose waitExit or wait");
		const exit = await wait.call(handle);
		return normalizeTerminalExit(exit, backend, this.killRequested);
	}

	private settleExit(exit: TerminalSessionExit): TerminalSessionExit {
		if (this.settledExit !== null) return this.settledExit;
		this.settledExit = exit;
		this.unsubscribeBackendData?.();
		this.unsubscribeBackendData = null;
		for (const handler of this.exitHandlers) handler();
		this.exitHandlers.clear();
		return exit;
	}

	private emitData(chunk: Buffer | Uint8Array | string): void {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.appendRawTail(buffer);
		for (const handler of this.dataHandlers) handler(buffer);
	}

	private appendRawTail(chunk: Buffer): void {
		this.rawByteCount += chunk.byteLength;
		if (this.rawTailLimit === 0) {
			this.rawTailBuffer = Buffer.alloc(0);
			return;
		}
		const next = Buffer.concat([this.rawTailBuffer, chunk]);
		this.rawTailBuffer =
			next.byteLength <= this.rawTailLimit ? next : next.subarray(next.byteLength - this.rawTailLimit);
	}
}

export function createTerminalSession(
	options: TerminalSessionOptions = {},
	dependencies: TerminalSessionDependencies = {},
): TerminalSession {
	return new TerminalSession(options, dependencies).start();
}
