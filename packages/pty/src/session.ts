import { Buffer } from "node:buffer";
import process from "node:process";
import { loadNativePty, type NativePtyLoadResult, type NativePtyUnavailableDiagnostic } from "./native-loader.ts";
import { PipeFallbackSession, shouldUsePipeFallback } from "./pipe-fallback.ts";
import { createBunTerminalSession, isBunTerminalEnabled } from "./session-bun.ts";
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
	TerminalSessionTerminateOptions,
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
	TerminalSessionTerminateOptions,
} from "./session-types.ts";

/** Default wait for a graceful exit before `terminate()` escalates to SIGKILL. */
const DEFAULT_TERMINATE_GRACE_MS = 5000;
/** Default wait for the exit after SIGKILL before `terminate()` reports failure. */
const DEFAULT_FORCED_GRACE_MS = 1000;
const FORCE_SIGNAL: TerminalSessionSignal = "SIGKILL";

export class TerminalSession {
	readonly options: TerminalSessionOptions;
	private readonly nativeLoadResult: NativePtyLoadResult;
	private readonly createNativeSessionDependency?: CreateNativeTerminalSession;
	private readonly env: Readonly<Record<string, string | undefined>>;
	private readonly runtimeVersions: import("./session-bun.ts").BunRuntimeVersions;
	private readonly bunRuntime: import("./session-bun.ts").BunRuntime | undefined;
	private readonly rawTailLimit: number;
	private readonly dataHandlers = new Set<TerminalSessionDataHandler>();
	private readonly exitHandlers = new Set<() => void>();
	private backendHandle: TerminalSessionHandle | null = null;
	private backendValue: TerminalSessionBackend | null = null;
	private exitPromise: Promise<TerminalSessionExit> | null = null;
	private settledExit: TerminalSessionExit | null = null;
	private rawTailBuffer = Buffer.alloc(0);
	private rawByteCount = 0;
	// Last signal actually handed to the backend. Tracking the signal (instead of a
	// boolean) keeps repeated kills idempotent while still letting an escalation
	// (e.g. SIGKILL after an ignored SIGTERM) reach the process.
	private lastSignal: TerminalSessionSignal | null = null;
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
		this.runtimeVersions =
			dependencies.runtimeVersions ?? (process.versions as import("./session-bun.ts").BunRuntimeVersions);
		this.bunRuntime = dependencies.bunRuntime;
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

		if (isBunTerminalEnabled(this.env, this.runtimeVersions)) {
			this.backendValue = "bun";
			this.backendHandle = createBunTerminalSession(
				toNativeOptions(this.options),
				(chunk) => this.emitData(chunk),
				this.bunRuntime,
			);
		} else {
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
		if (this.settledExit !== null) {
			return {
				ok: true,
				idempotent: true,
				note: "Terminal session has already exited.",
			};
		}
		if (this.lastSignal === signal) {
			return {
				ok: true,
				idempotent: true,
				note: "Terminal session kill was already requested.",
			};
		}
		if (handle === null) return notStartedOperation("kill");

		const previousSignal = this.lastSignal;
		this.lastSignal = signal;
		const result = normalizeOperationResult(handle.kill(signal), `Sent ${signal} to terminal session.`);
		if (!result.ok) this.lastSignal = previousSignal;
		return result;
	}

	stop(): TerminalSessionOperationResult {
		return this.kill();
	}

	/**
	 * Stop the session for real: signal (SIGTERM by default), wait `graceMs` for
	 * the exit, then escalate to SIGKILL and wait `forcedGraceMs`. Resolves with
	 * the settled exit, or `null` when the process outlived both waits (or was
	 * never started).
	 */
	async terminate(options: TerminalSessionTerminateOptions = {}): Promise<TerminalSessionExit | null> {
		if (this.settledExit !== null) return this.settledExit;
		if (this.backendHandle === null) return null;

		this.kill(options.signal ?? "SIGTERM");
		const graceful = await this.waitExitWithin(normalizeGraceMs(options.graceMs, DEFAULT_TERMINATE_GRACE_MS));
		if (graceful !== null) return graceful;

		this.kill(FORCE_SIGNAL);
		return await this.waitExitWithin(normalizeGraceMs(options.forcedGraceMs, DEFAULT_FORCED_GRACE_MS));
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
		return normalizeTerminalExit(exit, backend, this.lastSignal !== null);
	}

	/** Await the settled exit for at most `graceMs`; `null` means it did not settle in time. */
	private async waitExitWithin(graceMs: number): Promise<TerminalSessionExit | null> {
		if (this.settledExit !== null) return this.settledExit;
		const exitPromise = this.exitPromise;
		if (exitPromise === null || graceMs <= 0) return this.settledExit;

		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				// Attaching the catch here also keeps a late backend rejection from
				// surfacing as an unhandled rejection once the grace timer wins.
				exitPromise.catch(() => null),
				new Promise<null>((resolve) => {
					graceTimer = setTimeout(() => resolve(null), graceMs);
				}),
			]);
		} finally {
			if (graceTimer !== undefined) clearTimeout(graceTimer);
		}
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

function normalizeGraceMs(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
	return value;
}

export function createTerminalSession(
	options: TerminalSessionOptions = {},
	dependencies: TerminalSessionDependencies = {},
): TerminalSession {
	return new TerminalSession(options, dependencies).start();
}
