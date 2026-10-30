// Type-only re-exports: a value re-export would put the whole MCP SDK back into
// the CLI's startup import graph (see sdk.lazy.ts). Callers that need the
// classes themselves load them through that boundary.
export type { Client } from "@modelcontextprotocol/sdk/client/index.js";
export type { Server } from "@modelcontextprotocol/sdk/server/index.js";
export type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

import type { EventEmitter } from "node:events";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { EventBus } from "../../../event-bus.ts";
import { redactMcpLogText } from "./log.ts";

export interface McpClock {
	now(): number;
	schedule(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
	cancel(timer: ReturnType<typeof setTimeout>): void;
}

/** The modern operation uses one injectable monotonic clock and scheduler. */
export const mcpElapsedClock: McpClock = {
	now: () => performance.now(),
	schedule: (callback, ms) => setTimeout(callback, ms),
	cancel: (timer) => clearTimeout(timer),
};

export function mcpAbortableDelay(clock: McpClock, ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = () => {
			clock.cancel(timer);
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const abort = () => {
			clock.cancel(timer);
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		const timer = clock.schedule(finish, ms);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

/** Observe SDK close without replacing another request's observer. */
const clientCloseObservers = new WeakMap<
	Client,
	{
		listeners: Set<() => void>;
		prior: Client["onclose"];
		close: () => void;
	}
>();
export function onMcpClientClose(client: Client, listener: () => void): () => void {
	let state = clientCloseObservers.get(client);
	if (!state) {
		const listeners = new Set<() => void>();
		const prior = client.onclose;
		const close = () => {
			for (const callback of listeners) callback();
			prior?.();
		};
		state = { listeners, prior, close };
		clientCloseObservers.set(client, state);
		client.onclose = close;
	}
	state.listeners.add(listener);
	const current = state;
	return () => {
		current.listeners.delete(listener);
		if (current.listeners.size === 0) {
			if (client.onclose === current.close) client.onclose = current.prior;
			clientCloseObservers.delete(client);
		}
	};
}

export function mcpInterrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		void work.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

type MaybePromise<T> = T | Promise<T>;

export interface McpErrorLogger {
	error(message: string, data?: unknown): void;
}

export interface McpAsyncErrorSink {
	readonly logger: McpErrorLogger;
	readonly notify?: (message: string, error: Error) => MaybePromise<void>;
}

export type WrappedAsyncCallback<TArgs extends readonly unknown[]> = (...args: TArgs) => Promise<void>;

export function wrapAsync<TArgs extends readonly unknown[]>(
	scope: string,
	fn: (...args: TArgs) => MaybePromise<void>,
	sink: McpAsyncErrorSink,
): WrappedAsyncCallback<TArgs> {
	return async (...args: TArgs): Promise<void> => {
		try {
			await fn(...args);
		} catch (error) {
			const caughtError = error instanceof Error ? error : normalizeCaughtError(error);
			await reportMcpAsyncError(scope, caughtError, sink);
		}
	};
}

export function safeTimer(
	scope: string,
	delayMs: number,
	fn: () => MaybePromise<void>,
	sink: McpAsyncErrorSink,
): NodeJS.Timeout {
	const wrapped = wrapAsync(scope, fn, sink);
	const timer = setTimeout(() => {
		void wrapped();
	}, delayMs);
	timer.unref();
	return timer;
}

export function safeInterval(
	scope: string,
	delayMs: number,
	fn: () => MaybePromise<void>,
	sink: McpAsyncErrorSink,
): NodeJS.Timeout {
	const wrapped = wrapAsync(scope, fn, sink);
	const timer = setInterval(() => {
		void wrapped();
	}, delayMs);
	timer.unref();
	return timer;
}

export function safeDelay(delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, delayMs);
	});
}

export function safeOn(
	emitter: EventEmitter,
	eventName: string | symbol,
	scope: string,
	listener: (...args: unknown[]) => MaybePromise<void>,
	sink: McpAsyncErrorSink,
): () => void {
	const wrapped = wrapAsync(scope, listener, sink);
	emitter.on(eventName, wrapped);
	return () => {
		emitter.off(eventName, wrapped);
	};
}

export function safeEventBusOn(bus: EventBus, channel: string, handler: (data: unknown) => void): () => void {
	return bus.on(channel, handler);
}

export async function reportMcpAsyncError(scope: string, error: unknown, sink: McpAsyncErrorSink): Promise<void> {
	const normalized = normalizeError(error);
	logError(scope, normalized, sink.logger);

	if (!sink.notify) return;
	try {
		await sink.notify(`MCP ${scope} failed: ${normalized.message}`, normalized);
	} catch (notifyError) {
		const caughtNotifyError = notifyError instanceof Error ? notifyError : normalizeCaughtError(notifyError);
		logError(`${scope}.notify`, caughtNotifyError, sink.logger);
	}
}

function logError(scope: string, error: Error, logger: McpErrorLogger): void {
	try {
		logger.error(scope, serializeError(error));
	} catch {
		const redactedScope = redactMcpLogText(scope);
		console.error(`MCP ${redactedScope} logger failed; suppressed async error details`);
	}
}

interface SerializedError {
	name: string;
	message: string;
	stack?: string;
}

function serializeError(error: Error): SerializedError {
	const serialized: SerializedError = {
		name: error.name,
		message: error.message,
	};
	if (error.stack) serialized.stack = error.stack;
	return serialized;
}

function normalizeError(error: unknown): Error {
	if (error instanceof Error) return error;
	return normalizeCaughtError(error);
}

function normalizeCaughtError(error: unknown): Error {
	if (typeof error === "string") return new Error(error);
	return new Error(safeStringify(error));
}

function safeStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized ?? String(value);
	} catch {
		return String(value);
	}
}
