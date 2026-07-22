import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";

export type WireRecord = Record<string, unknown>;

type PendingResponse = {
	readonly resolve: (response: WireRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: NodeJS.Timeout;
};

type NotificationWaiter = {
	readonly predicate: (notification: WireRecord) => boolean;
	readonly resolve: (notification: WireRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: NodeJS.Timeout;
};

const QA_PORTS = [18990, 18991, 18992, 18993, 18994, 18995, 18996, 18997, 18998, 18999] as const;

export class FuzzyQaClient {
	private readonly socket: WebSocket;
	private nextId = 1;
	private readonly pending = new Map<number, PendingResponse>();
	private readonly notifications: WireRecord[] = [];
	private readonly waiters = new Set<NotificationWaiter>();

	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
	}

	request(method: string, params: unknown): Promise<WireRecord> {
		const id = this.nextId;
		this.nextId += 1;
		return new Promise((resolveResponse, rejectResponse) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				rejectResponse(new Error(`${method} timed out`));
			}, 10_000);
			this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timeout });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	waitForNotification(predicate: (notification: WireRecord) => boolean): Promise<WireRecord> {
		const existing = this.notifications.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolveNotification, rejectNotification) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(waiter);
				rejectNotification(new Error("notification timed out"));
			}, 10_000);
			const waiter: NotificationWaiter = {
				predicate,
				resolve: resolveNotification,
				reject: rejectNotification,
				timeout,
			};
			this.waiters.add(waiter);
		});
	}

	async close(): Promise<void> {
		if (this.socket.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolveClose) => {
			this.socket.once("close", () => resolveClose());
			this.socket.close();
		});
	}

	private handleMessage(data: RawData, isBinary: boolean): void {
		if (isBinary) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString("utf8"));
		} catch (error: unknown) {
			if (error instanceof Error) this.rejectAll(error);
			return;
		}
		if (!isRecord(parsed)) return;
		if (typeof parsed.id === "number") {
			const pending = this.pending.get(parsed.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.pending.delete(parsed.id);
			pending.resolve(parsed);
			return;
		}
		if (typeof parsed.method !== "string") return;
		this.notifications.push(parsed);
		for (const waiter of this.waiters) {
			if (!waiter.predicate(parsed)) continue;
			clearTimeout(waiter.timeout);
			this.waiters.delete(waiter);
			waiter.resolve(parsed);
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timeout);
			waiter.reject(error);
		}
		this.waiters.clear();
	}
}

export async function findQaPort(): Promise<number> {
	for (const port of QA_PORTS) {
		if (await canBind(port)) return port;
	}
	throw new Error("no free app-server QA port in 18990-18999");
}

export async function connectClient(port: number): Promise<FuzzyQaClient> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timeout = setTimeout(() => rejectOpen(new Error("websocket open timed out")), 10_000);
		socket.once("open", () => {
			clearTimeout(timeout);
			resolveOpen();
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			rejectOpen(error);
		});
	});
	return new FuzzyQaClient(socket);
}

export async function startSourceServer(input: {
	readonly repoRoot: string;
	readonly codingAgentDir: string;
	readonly port: number;
	readonly env: NodeJS.ProcessEnv;
}): Promise<ChildProcess> {
	const child = spawn(
		process.execPath,
		[
			join(input.repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			join(input.repoRoot, "tsconfig.json"),
			join(input.codingAgentDir, "src", "cli-main.ts"),
			"app-server",
			"--listen",
			`ws://127.0.0.1:${input.port}`,
			"--ws-auth",
			"off",
		],
		{ cwd: input.codingAgentDir, env: input.env, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout?.resume();
	await waitForReady(child);
	return child;
}

export async function stopSourceServer(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolveClose, rejectClose) => {
		const timeout = setTimeout(() => rejectClose(new Error("source app-server shutdown timed out")), 10_000);
		child.once("close", () => {
			clearTimeout(timeout);
			resolveClose();
		});
	});
}

export async function assertPortReusable(port: number): Promise<void> {
	if (!(await canBind(port))) throw new Error(`QA port ${port} remained in use`);
}

function waitForReady(child: ChildProcess): Promise<void> {
	return new Promise((resolveReady, rejectReady) => {
		let stderr = "";
		const timeout = setTimeout(
			() => rejectReady(new Error(`source app-server readiness timed out: ${stderr}`)),
			30_000,
		);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectReady(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			rejectReady(new Error(`source app-server exited before readiness: ${String(code ?? signal)}`));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (!stderr.includes("readyz http://127.0.0.1:")) return;
			clearTimeout(timeout);
			resolveReady();
		});
	});
}

function canBind(port: number): Promise<boolean> {
	return new Promise((resolveCheck) => {
		const server = createServer();
		server.once("error", () => resolveCheck(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolveCheck(true)));
	});
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
