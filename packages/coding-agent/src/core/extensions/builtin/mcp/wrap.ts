export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { Server } from "@modelcontextprotocol/sdk/server/index.js";
export type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

import type { EventEmitter } from "node:events";
import { redactMcpLogText } from "./log.ts";

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
