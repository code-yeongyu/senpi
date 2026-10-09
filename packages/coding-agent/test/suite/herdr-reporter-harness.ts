import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createHerdrExtension, type HerdrDependencies } from "../../src/core/extensions/builtin/herdr/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

export interface HerdrRequest {
	id: string;
	method: string;
	params: { seq: number; source: string; pane_id: string; [key: string]: unknown };
}
export type HerdrHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export function scriptedTransport(reply?: (socket: Socket, request: HerdrRequest, attempt: number) => void) {
	const requests: HerdrRequest[] = [];
	const sockets: Socket[] = [];
	const written = new EventEmitter();
	const connect = vi.fn(() => {
		const socket = new Socket();
		sockets.push(socket);
		vi.spyOn(socket, "write").mockImplementation((data) => {
			const request: HerdrRequest = JSON.parse(String(data));
			requests.push(request);
			written.emit("request", request);
			reply?.(socket, request, sockets.length);
			return true;
		});
		queueMicrotask(() => socket.emit("connect"));
		return socket;
	});
	return { requests, sockets, written, connect };
}

export function acknowledge(socket: Socket, request: HerdrRequest) {
	socket.emit("data", Buffer.from(`${JSON.stringify({ id: request.id, result: {} })}\n`));
}
const cleanups: Array<() => Promise<void> | void> = [];

export async function herdrReporterFixture(overrides: Partial<HerdrDependencies> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "herdr-reporter-"));
	const path =
		process.platform === "win32" ? `\\\\.\\pipe\\herdr-reporter-${dir.split(/[\\/]/).pop()}` : join(dir, "sock");
	const requests: HerdrRequest[] = [];
	const received = new EventEmitter();
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			const request: HerdrRequest = JSON.parse(buffer.slice(0, end));
			requests.push(request);
			socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
			received.emit("request", request);
		});
	});
	const listening = once(server, "listening", { signal: AbortSignal.timeout(5000) });
	server.listen(path);
	await listening;
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_SOCKET_PATH", path);
	vi.stubEnv("HERDR_PANE_ID", "pane-test");
	const lifecycle = new Map<string, HerdrHandler>();
	const events = new Map<string, (data: unknown) => unknown>();
	const debug = vi.fn();
	const connect = vi.fn((target: string) => createConnection(target));
	const deps: HerdrDependencies = {
		getLoadedExtensionPaths: () => [],
		readHeader: () => "",
		now: () => 1000,
		connect,
		debug,
		...overrides,
	};
	createHerdrExtension(deps)({
		on: ((name: string, handler: HerdrHandler) => {
			lifecycle.set(name, handler);
		}) as ExtensionAPI["on"],
		events: {
			on: (name, handler) => {
				events.set(name, handler);
				return () => {
					events.delete(name);
				};
			},
			emit: (name, data) => {
				events.get(name)?.(data);
			},
		},
	});
	let idle = true;
	let title: string | undefined = "Reporter QA";
	const ctx = {
		mode: "tui",
		cwd: dir,
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => "root-session",
			getSessionFile: () => "/sessions/root.jsonl",
			getSessionName: () => title,
		},
	} as ExtensionContext;
	const emit = async (type: string, extra: Record<string, unknown> = {}, context = ctx) => {
		await lifecycle.get(type)?.({ type, ...extra }, context);
	};
	const bus = async (name: string, data: unknown) => {
		await events.get(name)?.(data);
	};
	const start = () => emit("session_start", { reason: "startup" });
	cleanups.push(async () => {
		await emit("session_shutdown", { reason: "reload" });
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		dir,
		requests,
		received,
		connect,
		debug,
		ctx,
		emit,
		bus,
		start,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setTitle: (value: string | undefined) => {
			title = value;
		},
	};
}

export async function cleanupHerdrReporterFixtures(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
