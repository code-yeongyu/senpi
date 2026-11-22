import { Worker } from "node:worker_threads";
import { isBunBinary } from "../../../../config.ts";
import type { ResolverRequest, ResolverValue, ResolverWorkerMessage } from "./path-identity-protocol.ts";

/** The worker transport, injectable so a test can stall it without a real wedge. */
export interface ResolverTransport {
	post(request: ResolverRequest): void;
	onMessage(handler: (message: ResolverWorkerMessage) => void): void;
	onError(handler: (error: Error) => void): void;
	onExit(handler: () => void): void;
	terminate(): Promise<unknown>;
}

export interface ResolverRequestOptions {
	/** An eager rule fill: its own short deadline, and a miss never terminates, rejects others or trips the breaker. */
	readonly soft?: boolean;
	/** A soft request's answer that arrives after its deadline is still delivered here (the worker computed it anyway). */
	readonly onLate?: (value: ResolverValue) => void;
}

export class ResolverTimeoutError extends Error {
	readonly code = "ETIMEDOUT";
	constructor(detail: string) {
		super(`ETIMEDOUT: ${detail}`);
		this.name = "ResolverTimeoutError";
	}
}

export class ResolverUnavailableError extends Error {
	readonly code = "EUNAVAILABLE";
	constructor(detail: string) {
		super(`EUNAVAILABLE: ${detail}`);
		this.name = "ResolverUnavailableError";
	}
}

export class ResolverFailure extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "ResolverFailure";
		this.code = code;
	}
}

/** Bun wrapper builders define the worker entry name relative to their explicit --root. */
declare const SENPI_PATH_IDENTITY_WORKER_ENTRY: string | undefined;
const compiledWorkerEntry =
	typeof SENPI_PATH_IDENTITY_WORKER_ENTRY === "string"
		? SENPI_PATH_IDENTITY_WORKER_ENTRY
		: "./src/core/extensions/builtin/permission-system/path-identity-worker.ts";

/**
 * Where the worker lives in each shipped layout: the compiled binary embeds it under its source path
 * (an explicit `bun build --compile` entry), the npm bundle emits it beside the host's chunk, and the
 * source tree runs the `.ts` file directly.
 */
export function workerEntryFor(moduleUrl: string): string | URL {
	if (isBunBinary) return compiledWorkerEntry;
	return new URL(moduleUrl.endsWith(".ts") ? "./path-identity-worker.ts" : "./path-identity-worker.js", moduleUrl);
}

export function workerTransport(entry: string | URL): ResolverTransport {
	const worker = new Worker(entry);
	worker.unref();
	return {
		post: (request) => worker.postMessage(request),
		onMessage: (handler) => {
			worker.on("message", handler);
		},
		onError: (handler) => {
			worker.on("error", handler);
		},
		onExit: (handler) => {
			worker.on("exit", handler);
		},
		terminate: () => worker.terminate(),
	};
}
