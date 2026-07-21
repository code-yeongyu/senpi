import { readFileSync } from "node:fs";
import type { McpServerConfig } from "../../../src/core/extensions/builtin/mcp/config-schema.ts";

export function readNumberFile(path: string): number {
	return Number(readFileSync(path, "utf8").trim());
}

export function readNumberFileOrZero(path: string): number {
	try {
		return readNumberFile(path);
	} catch (error) {
		if (isNodeErrorCode(error, "ENOENT")) return 0;
		throw error;
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function serverConfig(): McpServerConfig {
	return {
		args: [],
		command: process.execPath,
		connectTimeoutMs: 2000,
		enabled: true,
		exposure: "auto",
		idleTimeoutMin: 10,
		lifecycle: "lazy",
		logLevel: "info",
		requestTimeoutMs: 30_000,
		startupTimeoutMs: 250,
		type: "stdio",
	};
}

export async function waitFor(assertion: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: Error | null = null;
	while (Date.now() < deadline) {
		try {
			if (assertion()) return;
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			lastError = error;
		}
		await delay(25);
	}
	if (lastError !== null) throw lastError;
	throw new Error("condition timed out");
}

function isNodeErrorCode(error: unknown, code: string): error is Error & { code: string } {
	return error instanceof Error && "code" in error && error.code === code;
}
