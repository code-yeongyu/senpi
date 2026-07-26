import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { VERSION } from "../../../config.ts";
import type { AppServerListen } from "../index.ts";

type TokenPaths = {
	readonly tokenFile: string;
};

type SettingsPaths = {
	readonly settingsFile: string;
};

type CleanupPaths = {
	readonly pidFile: string;
	readonly settingsFile: string;
};

type ProbeOutput = Readonly<Record<string, string | number | undefined>>;

export async function probeListen(
	paths: TokenPaths,
	listen: AppServerListen,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (listen.kind === "stdio" || signal?.aborted) return undefined;
	let token: string | undefined;
	try {
		token = (await readFile(paths.tokenFile, "utf8")).trim();
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT") && listen.kind === "ws") return undefined;
		if (!isNodeErrorCode(error, "ENOENT")) throw error;
		token = undefined;
	}
	const probeTarget =
		listen.kind === "ws"
			? listen.url
			: `ws+unix://${listen.path ?? join(dirname(paths.tokenFile), "app-server.sock")}:/`;
	return probeWebSocket(probeTarget, token && token.length > 0 ? token : undefined, timeoutMs, signal);
}

export function probeWebSocket(
	url: string,
	token: string | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return new Promise((resolveProbe) => {
		if (signal?.aborted) {
			resolveProbe(undefined);
			return;
		}
		let settled = false;
		const socket = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
		const finish = (result: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			socket.terminate();
			resolveProbe(result);
		};
		const onAbort = (): void => finish(undefined);
		const timeout = setTimeout(() => finish(undefined), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		socket.once("open", () => {
			socket.send(
				JSON.stringify({
					id: 1,
					method: "initialize",
					params: {
						clientInfo: { name: "senpi_app_server_daemon", title: "senpi app-server daemon", version: VERSION },
					},
				}),
			);
		});
		socket.once("message", (data, isBinary) => {
			if (isBinary) {
				finish(undefined);
				return;
			}
			finish(readInitializeProbe(data.toString("utf8")));
		});
		socket.once("error", () => finish(undefined));
		socket.once("close", () => finish(undefined));
	});
}

export async function pollProbe(
	paths: TokenPaths,
	listen: AppServerListen,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (signal?.aborted) return undefined;
		const probe = await probeListen(paths, listen, 2_000, signal);
		if (probe) return probe;
		if (signal?.aborted) return undefined;
		await delay(100, signal);
	}
	return undefined;
}

export function readInitializeProbe(text: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error: unknown) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (!isRecord(parsed) || parsed.id !== 1 || !isRecord(parsed.result)) return undefined;
	const userAgent = parsed.result.userAgent;
	return typeof userAgent === "string" ? userAgent : undefined;
}

export async function readSettings(paths: SettingsPaths): Promise<{ readonly listen: AppServerListen } | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(paths.settingsFile, "utf8"));
		if (!isRecord(parsed)) return undefined;
		const listen = parseListen(parsed.listen);
		return listen ? { listen } : undefined;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export function parseListen(value: unknown): AppServerListen | undefined {
	if (!isRecord(value) || typeof value.kind !== "string" || typeof value.url !== "string") return undefined;
	if (value.kind === "stdio" && value.url === "stdio://") return { kind: "stdio", url: "stdio://" };
	if (value.kind === "unix") {
		return typeof value.path === "string"
			? { kind: "unix", url: value.url, path: value.path }
			: { kind: "unix", url: value.url };
	}
	if (value.kind === "ws" && typeof value.host === "string" && typeof value.port === "number") {
		return { kind: "ws", url: value.url, host: value.host, port: value.port };
	}
	return undefined;
}

export async function cleanupState(paths: CleanupPaths, listen: AppServerListen): Promise<void> {
	await rm(paths.pidFile, { force: true });
	await rm(paths.settingsFile, { force: true });
	if (listen.kind === "unix" && listen.path) await rm(listen.path, { force: true });
}

export function runningOutput(
	status: "already-running" | "running",
	pid: number | undefined,
	listen: AppServerListen,
	version: string,
): ProbeOutput {
	if (pid === undefined) return runningUnmanagedOutput(listen, version);
	return { status, pid, listen: listen.url, version };
}

export function runningUnmanagedOutput(listen: AppServerListen, version: string): ProbeOutput {
	return { status: "running-unmanaged", listen: listen.url, version };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolveDelay) => {
		if (signal?.aborted) {
			resolveDelay();
			return;
		}
		const finish = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", finish);
			resolveDelay();
		};
		const timeout = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
