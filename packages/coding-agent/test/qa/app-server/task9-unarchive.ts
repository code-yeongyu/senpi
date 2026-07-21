import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";

type WireRecord = { readonly [key: string]: unknown };

type RunningServer = {
	readonly child: ChildProcess;
	readonly port: number;
};

type ResponseWaiter = {
	readonly id: string;
	readonly resolve: (response: WireRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

type FrameWaiter = {
	readonly predicate: (frame: WireRecord) => boolean;
	readonly resolve: (frame: WireRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

const QA_PORTS = [18990, 18991, 18992, 18993, 18994, 18995, 18996, 18997, 18998, 18999] as const;
const codingAgentDir = process.cwd();
const repoRoot = resolve(codingAgentDir, "../..");

class WebSocketClient {
	readonly frames: WireRecord[] = [];
	private readonly socket: WebSocket;
	private readonly responseWaiters: ResponseWaiter[] = [];
	private readonly frameWaiters: FrameWaiter[] = [];
	private nextId = 1;

	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.on("message", (data: RawData, isBinary: boolean) => {
			if (isBinary) return;
			const parsed: unknown = JSON.parse(data.toString("utf8"));
			if (!isRecord(parsed)) return;
			this.frames.push(parsed);
			this.resolveResponse(parsed);
			this.resolveFrameWaiters(parsed);
		});
	}

	request(method: string, params?: unknown): Promise<WireRecord> {
		const id = `task9-${this.nextId}`;
		this.nextId += 1;
		return new Promise<WireRecord>((resolveResponse, rejectResponse) => {
			const timer = setTimeout(() => {
				const index = this.responseWaiters.findIndex((waiter) => waiter.id === id);
				if (index >= 0) this.responseWaiters.splice(index, 1);
				rejectResponse(new Error(`${method} timed out`));
			}, 10_000);
			this.responseWaiters.push({ id, resolve: resolveResponse, reject: rejectResponse, timer });
			const payload = params === undefined ? { id, method } : { id, method, params };
			this.socket.send(JSON.stringify(payload), (error) => {
				if (!error) return;
				clearTimeout(timer);
				const index = this.responseWaiters.findIndex((waiter) => waiter.id === id);
				if (index >= 0) this.responseWaiters.splice(index, 1);
				rejectResponse(error);
			});
		});
	}

	waitForFrame(predicate: (frame: WireRecord) => boolean): Promise<WireRecord> {
		const existing = this.frames.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise<WireRecord>((resolveFrame, rejectFrame) => {
			const timer = setTimeout(() => {
				const index = this.frameWaiters.findIndex((waiter) => waiter.timer === timer);
				if (index >= 0) this.frameWaiters.splice(index, 1);
				rejectFrame(new Error("timed out waiting for notification"));
			}, 10_000);
			this.frameWaiters.push({ predicate, resolve: resolveFrame, reject: rejectFrame, timer });
		});
	}

	async close(): Promise<void> {
		if (this.socket.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolveClose) => {
			const timer = setTimeout(() => {
				this.socket.terminate();
				resolveClose();
			}, 2_000);
			this.socket.once("close", () => {
				clearTimeout(timer);
				resolveClose();
			});
			this.socket.close();
		});
	}

	private resolveResponse(frame: WireRecord): void {
		if (typeof frame.id !== "string") return;
		const index = this.responseWaiters.findIndex((waiter) => waiter.id === frame.id);
		if (index < 0) return;
		const waiter = this.responseWaiters.splice(index, 1)[0];
		if (!waiter) return;
		clearTimeout(waiter.timer);
		waiter.resolve(frame);
	}

	private resolveFrameWaiters(frame: WireRecord): void {
		for (let index = this.frameWaiters.length - 1; index >= 0; index -= 1) {
			const waiter = this.frameWaiters[index];
			if (!waiter?.predicate(frame)) continue;
			this.frameWaiters.splice(index, 1);
			clearTimeout(waiter.timer);
			waiter.resolve(frame);
		}
	}
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-qa-task9-unarchive-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const homeDir = join(root, "home");
	const tempDir = join(root, "tmp");
	const sockets: WebSocketClient[] = [];
	let server: RunningServer | undefined;
	let port: number | undefined;
	try {
		await Promise.all([
			mkdir(agentDir, { recursive: true }),
			mkdir(sessionDir, { recursive: true }),
			mkdir(homeDir, { recursive: true }),
			mkdir(tempDir, { recursive: true }),
		]);
		port = await findQaPort();
		server = await startSourceAppServer(port, hermeticEnv({ root, agentDir, sessionDir, homeDir, tempDir }));
		const client = new WebSocketClient(await connect(port));
		sockets.push(client);
		await initialize(client);

		const threadId = "55555555-5555-4555-8555-555555555555";
		await writePersistedSession(sessionDir, root, threadId);

		assertResult(await client.request("thread/archive", { threadId }), "thread/archive");
		const archivedList = resultRecord(await client.request("thread/list", { archived: true }), "thread/list");
		const archivedThread = findThread(arrayField(archivedList, "data"), threadId);
		const archivedUpdatedAt = numberField(archivedThread, "updatedAt");

		const unarchived = await client.request("thread/unarchive", { threadId });
		const unarchivedResult = resultRecord(unarchived, "thread/unarchive");
		const unarchivedThread = recordField(unarchivedResult, "thread");
		const unarchivedStatus = recordField(unarchivedThread, "status");
		assert.equal(unarchivedStatus.type, "notLoaded");
		const unarchivedUpdatedAt = numberField(unarchivedThread, "updatedAt");
		assert.ok(unarchivedUpdatedAt > archivedUpdatedAt);
		const responseIndex = client.frames.indexOf(unarchived);
		assert.ok(responseIndex >= 0);
		await client.waitForFrame(
			(frame) => frame.method === "thread/unarchived" && recordField(frame, "params").threadId === threadId,
		);
		const broadcastIndex = client.frames.findIndex(
			(frame, index) =>
				index > responseIndex &&
				frame.method === "thread/unarchived" &&
				recordField(frame, "params").threadId === threadId,
		);
		assert.ok(broadcastIndex > responseIndex);
		const coldList = resultRecord(await client.request("thread/list", {}), "thread/list");
		const coldThread = findThread(arrayField(coldList, "data"), threadId);
		assert.ok(numberField(coldThread, "updatedAt") >= unarchivedUpdatedAt);

		const loaded = resultRecord(await client.request("thread/loaded/list"), "thread/loaded/list");
		assert.equal(
			arrayField(loaded, "data").some((value) => isRecord(value) && value.id === threadId),
			false,
		);

		const resumed = resultRecord(await client.request("thread/resume", { threadId }), "thread/resume");
		assert.equal(recordField(recordField(resumed, "thread"), "status").type, "idle");

		const unknown = await client.request("thread/unarchive", { threadId: "99999999-9999-4999-8999-999999999999" });
		assertRpcError(unknown, -32600);
		const doubleUnarchive = await client.request("thread/unarchive", { threadId });
		assertRpcError(doubleUnarchive, -32600);

		console.log("STATUS_NOTLOADED=1");
		console.log("BROADCAST_AFTER_RESPONSE=1");
		console.log("RESUME_AFTER=1");
		console.log("UNKNOWN_ID_INVALID=1");
		console.log("DOUBLE_UNARCHIVE_INVALID=1");
		console.log("TIMESTAMP_PERSISTED=1");
		console.log("EXIT=0");
	} finally {
		await Promise.all(sockets.map((socket) => socket.close()));
		if (server) await stopServer(server.child);
		await rm(root, { recursive: true, force: true });
		if (port !== undefined) await assertPortReusable(port);
	}
}

function hermeticEnv(paths: {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly homeDir: string;
	readonly tempDir: string;
}): NodeJS.ProcessEnv {
	return {
		CI: "1",
		HOME: paths.homeDir,
		LANG: "C.UTF-8",
		NO_COLOR: "1",
		NO_PROXY: "127.0.0.1,localhost",
		PATH: process.env.PATH,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		SENPI_CODING_AGENT_DIR: paths.agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
		TMPDIR: paths.tempDir,
		USERPROFILE: paths.homeDir,
		XDG_CACHE_HOME: join(paths.root, "xdg-cache"),
		XDG_CONFIG_HOME: join(paths.root, "xdg-config"),
		XDG_DATA_HOME: join(paths.root, "xdg-data"),
	};
}

async function startSourceAppServer(port: number, env: NodeJS.ProcessEnv): Promise<RunningServer> {
	const child = spawn(
		process.execPath,
		[
			join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			join(repoRoot, "tsconfig.json"),
			join(codingAgentDir, "src", "cli-main.ts"),
			"app-server",
			"--listen",
			`ws://127.0.0.1:${port}`,
			"--ws-auth",
			"off",
		],
		{ cwd: codingAgentDir, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout?.resume();
	child.stderr?.resume();
	let spawnError: Error | undefined;
	child.once("error", (error) => {
		spawnError = error;
	});
	try {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (spawnError) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`source app-server exited before readiness: ${String(child.exitCode ?? child.signalCode)}`);
			}
			if ((await readyStatus(port)) === 200) return { child, port };
			await delay(25);
		}
		throw new Error("source app-server did not become ready within 30 seconds");
	} catch (error: unknown) {
		await stopServer(child);
		throw error;
	}
}

async function initialize(client: WebSocketClient): Promise<void> {
	const response = await client.request("initialize", {
		clientInfo: { name: "task9-qa", title: "Task 9 QA", version: "0.0.1" },
		capabilities: { experimentalApi: true, requestAttestation: false },
	});
	assertResult(response, "initialize");
}

async function writePersistedSession(sessionDir: string, cwd: string, threadId: string): Promise<void> {
	await writeFile(
		join(sessionDir, `2026-07-02T00-00-00-000Z_${threadId}.jsonl`),
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: threadId,
				timestamp: "2026-07-02T00:00:00.000Z",
				cwd,
			}),
			"",
		].join("\n"),
	);
}

function resultRecord(response: WireRecord, method: string): WireRecord {
	assertResult(response, method);
	return recordValue(response.result, `${method} result`);
}

function assertResult(response: WireRecord, method: string): void {
	if ("error" in response) {
		throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
	}
}

function assertRpcError(response: WireRecord, code: number): void {
	const error = recordValue(response.error, "RPC error");
	assert.equal(error.code, code);
}

function findThread(values: readonly unknown[], threadId: string): WireRecord {
	const thread = values.find((value) => isRecord(value) && value.id === threadId);
	return recordValue(thread, `thread ${threadId}`);
}

function recordField(value: WireRecord, key: string): WireRecord {
	return recordValue(value[key], `${key} field`);
}

function numberField(value: WireRecord, key: string): number {
	const field = value[key];
	if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`expected numeric field ${key}`);
	return field;
}

function arrayField(value: WireRecord, key: string): readonly unknown[] {
	const field = value[key];
	if (!Array.isArray(field)) throw new Error(`expected array field ${key}`);
	return field;
}

function recordValue(value: unknown, label: string): WireRecord {
	if (!isRecord(value)) throw new Error(`expected object for ${label}`);
	return value;
}

async function connect(port: number): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timeout = setTimeout(() => rejectOpen(new Error("websocket connection timed out")), 10_000);
		socket.once("open", () => {
			clearTimeout(timeout);
			resolveOpen();
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			rejectOpen(error);
		});
	});
	return socket;
}

async function stopServer(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	if (await waitForClose(child, 5_000)) return;
	child.kill("SIGKILL");
	await waitForClose(child, 5_000);
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise<boolean>((resolveClose) => {
		const timeout = setTimeout(() => resolveClose(false), timeoutMs);
		child.once("close", () => {
			clearTimeout(timeout);
			resolveClose(true);
		});
	});
}

function readyStatus(port: number): Promise<number> {
	return new Promise<number>((resolveStatus) => {
		const req = request({ host: "127.0.0.1", port, path: "/readyz", method: "GET", timeout: 500 }, (response) => {
			response.resume();
			resolveStatus(response.statusCode ?? 0);
		});
		req.once("timeout", () => req.destroy());
		req.once("error", () => resolveStatus(0));
		req.end();
	});
}

async function findQaPort(): Promise<number> {
	for (const port of QA_PORTS) {
		if (await canBind(port)) return port;
	}
	throw new Error("expected a free port in the QA range 18990-18999");
}

async function assertPortReusable(port: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await canBind(port)) return;
		await delay(25);
	}
	throw new Error(`QA port ${port} remained in use after bounded cleanup retries`);
}

function canBind(port: number): Promise<boolean> {
	return new Promise<boolean>((resolveBind, rejectBind) => {
		const probe = createServer();
		probe.unref();
		probe.once("error", (error: unknown) => {
			if (isNodeErrorCode(error, "EADDRINUSE")) {
				resolveBind(false);
				return;
			}
			rejectBind(error);
		});
		probe.listen(port, "127.0.0.1", () => {
			probe.close(() => resolveBind(true));
		});
	});
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
