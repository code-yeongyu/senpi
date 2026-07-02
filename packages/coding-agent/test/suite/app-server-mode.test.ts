import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";
import { restoreStdout } from "../../src/core/output-guard.ts";
import { runAppServerMode } from "../../src/modes/app-server/index.ts";

const runningModes: Array<Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
	if (runningModes.length > 0) {
		process.emit("SIGTERM", "SIGTERM");
	}
	await Promise.allSettled(runningModes.splice(0));
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
	restoreStdout();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("app-server mode entry", () => {
	it("boots a websocket loopback mode and shuts down cleanly after thread lifecycle requests", async () => {
		// Given: isolated app-server state and a mode entry listening on a QA loopback port.
		const root = await scratchRoot();
		vi.stubEnv("SENPI_CODING_AGENT_DIR", join(root, "agent"));
		vi.stubEnv("SENPI_CODING_AGENT_SESSION_DIR", join(root, "sessions"));
		vi.stubEnv("PI_OFFLINE", "1");
		vi.spyOn(process, "exit").mockImplementation(exitThrows);
		const banner = captureStderrPort();
		const mode = runAppServerMode({
			kind: "server",
			listen: {
				kind: "ws",
				url: "ws://127.0.0.1:0",
				host: "127.0.0.1",
				port: 0,
			},
			wsAuth: { kind: "off" },
			jsonLogs: false,
		});
		runningModes.push(mode);

		// When: a real websocket client drives initialize, start, loaded/list, and unsubscribe.
		const port = await Promise.race([banner.wait, mode.then(() => failModeExited())]);
		const socket = await openSocket(port);
		const reader = new BufferedSocketReader(socket);
		try {
			socket.send(JSON.stringify(initializeRequest(1)));
			await expect(reader.read()).resolves.toMatchObject({ id: 1, result: { userAgent: expect.any(String) } });
			socket.send(JSON.stringify({ method: "initialized", params: {} }));
			socket.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root } }));
			const started = await reader.readUntilResponse(2);
			const threadId = threadIdFromResponse(started);

			socket.send(JSON.stringify({ id: 3, method: "thread/loaded/list", params: {} }));
			expect(await reader.readUntilResponse(3)).toMatchObject({
				id: 3,
				result: {
					data: [
						expect.objectContaining({
							id: threadId,
							sessionId: threadId,
							modelProvider: expect.any(String),
							createdAt: expect.any(Number),
							updatedAt: expect.any(Number),
							status: { type: "idle" },
							turns: [],
						}),
					],
				},
			});
			socket.send(JSON.stringify({ id: 4, method: "thread/unsubscribe", params: { threadId } }));
			expect(await reader.readUntilResponse(4)).toEqual({ id: 4, result: { status: "unsubscribed" } });
		} finally {
			reader.dispose();
			socket.close();
		}
		process.emit("SIGTERM", "SIGTERM");
		await expect(mode).resolves.toBeUndefined();
		runningModes.splice(runningModes.indexOf(mode), 1);

		// Then: the listener releases its port and the process-level signal handler is gone.
		await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
		banner.restore();
	});

	it("continues an active turn when a websocket closes mid-turn and replays terminal completion", async () => {
		// Given: app-server mode uses an isolated faux provider and the first websocket owns an active turn.
		const root = await scratchRoot();
		const completionGate = createDeferred();
		const faux = registerFauxProvider({ schedulerHook: () => completionGate.promise });
		faux.setResponses([fauxAssistantMessage("close-mid-turn complete")]);
		await seedFauxConfig(root, faux);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", join(root, "agent"));
		vi.stubEnv("SENPI_CODING_AGENT_SESSION_DIR", join(root, "sessions"));
		vi.stubEnv("PI_OFFLINE", "1");
		vi.spyOn(process, "exit").mockImplementation(exitThrows);
		const banner = captureStderrPort();
		const mode = runAppServerMode({
			kind: "server",
			listen: {
				kind: "ws",
				url: "ws://127.0.0.1:0",
				host: "127.0.0.1",
				port: 0,
			},
			wsAuth: { kind: "off" },
			jsonLogs: false,
		});
		runningModes.push(mode);

		const port = await Promise.race([banner.wait, mode.then(() => failModeExited())]);
		const firstSocket = await openSocket(port);
		const firstReader = new BufferedSocketReader(firstSocket);
		let secondReader: BufferedSocketReader | undefined;
		let secondSocket: WebSocket | undefined;
		try {
			await initializeSocket(firstSocket, firstReader);
			firstSocket.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root } }));
			const threadId = threadIdFromResponse(await firstReader.readUntilResponse(2));
			firstSocket.send(
				JSON.stringify({
					id: 3,
					method: "turn/start",
					params: { threadId, input: [{ type: "text", text: "continue after websocket close" }] },
				}),
			);
			const turnResponse = await firstReader.readUntilResponse(3);
			const turnId = turnIdFromResponse(turnResponse);
			expect(await firstReader.readUntilNotification("turn/started")).toMatchObject({
				method: "turn/started",
				params: { threadId, turn: expect.objectContaining({ id: turnId, status: "inProgress" }) },
			});

			// When: the subscribed websocket closes before the faux provider finishes the turn.
			await eventually(() => expect(faux.state.callCount).toBe(1));
			firstReader.dispose();
			await closeSocket(firstSocket);
			secondSocket = await openSocket(port);
			secondReader = new BufferedSocketReader(secondSocket);
			await initializeSocket(secondSocket, secondReader);
			secondSocket.send(JSON.stringify({ id: 4, method: "thread/loaded/list", params: {} }));
			expect(await secondReader.readUntilResponse(4)).toMatchObject({
				id: 4,
				result: {
					data: [
						expect.objectContaining({
							id: threadId,
							sessionId: threadId,
							modelProvider: expect.any(String),
							createdAt: expect.any(Number),
							status: { type: "active", activeFlags: [] },
							turns: [],
						}),
					],
				},
			});
			completionGate.resolve();
			secondSocket.send(JSON.stringify({ id: 5, method: "thread/resume", params: { threadId } }));

			// Then: the thread remains loaded, and the terminal completion queued with zero subscribers replays on resume.
			const completed = await secondReader.readUntilNotification("turn/completed");
			expect(completed).toMatchObject({
				method: "turn/completed",
				params: { threadId, turn: expect.objectContaining({ id: turnId, status: "completed" }) },
			});
			expect(await secondReader.readUntilResponse(5)).toMatchObject({
				id: 5,
				result: { thread: expect.objectContaining({ id: threadId }) },
			});
			secondSocket.send(JSON.stringify({ id: 6, method: "thread/loaded/list", params: {} }));
			expect(await secondReader.readUntilResponse(6)).toMatchObject({
				id: 6,
				result: { data: [expect.objectContaining({ id: threadId })] },
			});
			expect(faux.state.callCount).toBe(1);
		} finally {
			firstReader.dispose();
			firstSocket.close();
			secondReader?.dispose();
			secondSocket?.close();
			faux.unregister();
			process.emit("SIGTERM", "SIGTERM");
			await expect(mode).resolves.toBeUndefined();
			runningModes.splice(runningModes.indexOf(mode), 1);
			banner.restore();
		}
	});
});

function exitThrows(code?: string | number | null): never {
	throw new Error(`process.exit ${String(code)}`);
}

function failModeExited(): never {
	throw new Error("app-server mode exited before startup");
}

async function scratchRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-app-server-mode-"));
	roots.push(root);
	return root;
}

function captureStderrPort(): { readonly wait: Promise<number>; restore(): void } {
	const original = process.stderr.write;
	let buffer = "";
	let resolved = false;
	let resolvePort: (port: number) => void = () => {};
	let rejectPort: (error: Error) => void = () => {};
	const wait = new Promise<number>((resolve, reject) => {
		resolvePort = resolve;
		rejectPort = reject;
	});
	const timeout = setTimeout(() => {
		if (!resolved) rejectPort(new Error(`startup banner not observed: ${buffer}`));
	}, 5_000);

	process.stderr.write = function writeStderr(
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | (() => void),
		callback?: () => void,
	): boolean {
		buffer += String(chunk);
		const match = /readyz http:\/\/127\.0\.0\.1:(\d+)\/readyz/.exec(buffer);
		if (!resolved && match) {
			resolved = true;
			clearTimeout(timeout);
			resolvePort(Number(match[1]));
		}
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	};

	return {
		wait,
		restore() {
			clearTimeout(timeout);
			process.stderr.write = original;
		},
	};
}

function initializeRequest(id: number): Record<string, unknown> {
	return {
		id,
		method: "initialize",
		params: { clientInfo: { name: "qa-mode", title: "QA", version: "1.0.0" } },
	};
}

async function seedFauxConfig(root: string, faux: ReturnType<typeof registerFauxProvider>): Promise<void> {
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const model = faux.getModel();
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, disabledBuiltinExtensions: [] }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[model.provider]: {
						api: model.api,
						baseUrl: model.baseUrl,
						apiKey: "faux-key",
						models: [{ id: model.id, name: model.name, input: model.input }],
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

function deferOneTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function openSocket(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});
}

function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		socket.once("close", () => resolve());
		socket.once("error", reject);
		socket.close();
	});
}

async function initializeSocket(socket: WebSocket, reader: BufferedSocketReader): Promise<void> {
	socket.send(JSON.stringify(initializeRequest(1)));
	await expect(reader.readUntilResponse(1)).resolves.toMatchObject({
		id: 1,
		result: { userAgent: expect.any(String) },
	});
	socket.send(JSON.stringify({ method: "initialized", params: {} }));
}

type SocketWaiter = {
	readonly resolve: (message: Record<string, unknown>) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
};

class BufferedSocketReader {
	private readonly messages: Record<string, unknown>[] = [];
	private readonly waiters: SocketWaiter[] = [];
	private readonly socket: WebSocket;

	constructor(socket: WebSocket) {
		this.socket = socket;
		this.socket.on("message", this.onMessage);
		this.socket.on("error", this.onError);
		this.socket.on("close", this.onClose);
	}

	dispose(): void {
		this.socket.off("message", this.onMessage);
		this.socket.off("error", this.onError);
		this.socket.off("close", this.onClose);
		for (const waiter of this.waiters.splice(0)) {
			clearTimeout(waiter.timeout);
			waiter.reject(new Error("socket reader disposed"));
		}
	}

	read(timeoutMs = 5_000): Promise<Record<string, unknown>> {
		const message = this.messages.shift();
		if (message) {
			return Promise.resolve(message);
		}
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const index = this.waiters.findIndex((waiter) => waiter.reject === reject);
				if (index !== -1) {
					this.waiters.splice(index, 1);
				}
				reject(new Error(`websocket frame not observed within ${timeoutMs}ms`));
			}, timeoutMs);
			this.waiters.push({ resolve, reject, timeout });
		});
	}

	async readUntilResponse(id: number): Promise<Record<string, unknown>> {
		const skipped: Record<string, unknown>[] = [];
		for (let index = 0; index < 16; index++) {
			const message = await this.readFor(`response ${id}`);
			if (message.id === id) {
				this.messages.unshift(...skipped);
				return message;
			}
			skipped.push(message);
		}
		this.messages.unshift(...skipped);
		throw new Error(`response ${id} not observed`);
	}

	async readUntilNotification(method: string): Promise<Record<string, unknown>> {
		const skipped: Record<string, unknown>[] = [];
		for (let index = 0; index < 16; index++) {
			const message = await this.readFor(`notification ${method}`);
			if (message.method === method) {
				this.messages.unshift(...skipped);
				return message;
			}
			skipped.push(message);
		}
		this.messages.unshift(...skipped);
		throw new Error(`notification ${method} not observed`);
	}

	private async readFor(label: string): Promise<Record<string, unknown>> {
		try {
			return await this.read();
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`${label} not observed: ${detail}`);
		}
	}

	private readonly onMessage = (data: RawData, isBinary: boolean): void => {
		if (isBinary) {
			this.rejectNext(new Error("expected text websocket frame"));
			return;
		}
		const parsed: unknown = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
		expectRecord(parsed);
		this.push(parsed);
	};

	private readonly onError = (error: Error): void => {
		this.rejectNext(error);
	};

	private readonly onClose = (): void => {
		this.rejectNext(new Error("websocket closed"));
	};

	private push(message: Record<string, unknown>): void {
		const waiter = this.waiters.shift();
		if (!waiter) {
			this.messages.push(message);
			return;
		}
		clearTimeout(waiter.timeout);
		waiter.resolve(message);
	}

	private rejectNext(error: Error): void {
		const waiter = this.waiters.shift();
		if (!waiter) {
			return;
		}
		clearTimeout(waiter.timeout);
		waiter.reject(error);
	}
}

function threadIdFromResponse(response: Record<string, unknown>): string {
	expectRecord(response.result);
	expectRecord(response.result.thread);
	const threadId = response.result.thread.id;
	if (typeof threadId !== "string") {
		throw new Error("thread/start response missing thread id");
	}
	return threadId;
}

function turnIdFromResponse(response: Record<string, unknown>): string {
	expectRecord(response.result);
	expectRecord(response.result.turn);
	const turnId = response.result.turn.id;
	if (typeof turnId !== "string") {
		throw new Error("turn/start response missing turn id");
	}
	return turnId;
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await assertion();
			return;
		} catch (error: unknown) {
			lastError = error;
			await deferOneTick();
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function expectRecord(value: unknown): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected object");
	}
}
