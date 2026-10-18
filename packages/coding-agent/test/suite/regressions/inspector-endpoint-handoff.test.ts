import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

interface InspectorState {
	readonly url: string;
	enabled: boolean;
	paused: boolean;
	resumed: boolean;
	error?: string;
}

interface RunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly states: readonly InspectorState[];
}

class FakeInspectorSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static instances: FakeInspectorSocket[] = [];

	readyState = FakeInspectorSocket.CONNECTING;
	closeCalls = 0;
	readonly sent: string[] = [];
	readonly url: string;

	constructor(url: string) {
		super();
		this.url = url;
		FakeInspectorSocket.instances.push(this);
	}

	send(message: string): void {
		this.sent.push(message);
	}

	close(): void {
		this.closeCalls += 1;
		this.readyState = FakeInspectorSocket.CLOSED;
	}

	open(): void {
		this.readyState = FakeInspectorSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	receive(message: object): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
	}
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => reject(new Error("Expected a TCP server address")));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

function sanitizedChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
	delete env.NODE_OPTIONS;
	return env;
}

function waitForClose(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("process-tree cleanup timed out")), timeoutMs);
		timer.unref();
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function terminateProcessTree(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
	if (child.exitCode !== null || child.pid === undefined) return;
	const closed = waitForClose(child, 5_000);
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("ESRCH")) throw error;
		}
	}
	await closed;
}

function parseMessage(data: unknown): { id?: number; method?: string; error?: unknown } {
	if (typeof data !== "object" || data === null) return {};
	const record = Array.isArray(data) ? {} : data;
	return {
		id: "id" in record && typeof record.id === "number" ? record.id : undefined,
		method: "method" in record && typeof record.method === "string" ? record.method : undefined,
		error: "error" in record ? record.error : undefined,
	};
}

function attachDebugger(url: string, sockets: WebSocket[], states: InspectorState[]): void {
	const state: InspectorState = { url, enabled: false, paused: false, resumed: false };
	states.push(state);
	const socket = new WebSocket(url);
	sockets.push(socket);
	// `Runtime.runIfWaitingForDebugger` must not be sent until `Debugger.enable`
	// has been ACKNOWLEDGED. Pipelining both on `open` lets the child resume before
	// the debugger domain is active, so `Debugger.paused` never arrives, `resumed`
	// stays false, and the run hangs until the outer timeout.
	socket.addEventListener("open", () => {
		socket.send(JSON.stringify({ id: 1, method: "Debugger.enable" }));
	});
	socket.addEventListener("message", (event) => {
		const message = parseMessage(JSON.parse(String(event.data)));
		if (message.error !== undefined) {
			state.error = `CDP error: ${JSON.stringify(message.error)}`;
			return;
		}
		if (message.id === 1) {
			state.enabled = true;
			socket.send(JSON.stringify({ id: 2, method: "Runtime.runIfWaitingForDebugger" }));
		}
		if (message.method === "Debugger.paused") {
			state.paused = true;
			socket.send(JSON.stringify({ id: 3, method: "Debugger.resume" }));
		}
		if (message.id === 3) {
			state.resumed = true;
			socket.close();
		}
	});
	socket.addEventListener("error", () => {
		if (!state.resumed) state.error = `Inspector socket failed before resume: ${url}`;
	});
}

function driveRun(child: ChildProcessByStdio<null, Readable, Readable>): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const sockets: WebSocket[] = [];
		const states: InspectorState[] = [];
		const attached = new Set<string>();
		const timer = setTimeout(
			() => reject(new Error(`--inspect-brk handoff timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
			150_000,
		);
		timer.unref();
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			for (const match of stderr.matchAll(/Debugger listening on (ws:\/\/\S+)/g)) {
				const url = match[1];
				if (url === undefined || attached.has(url)) continue;
				attached.add(url);
				attachDebugger(url, sockets, states);
			}
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, states });
		});
	});
}

function isPrelaunchCollision(result: RunResult): boolean {
	return result.states.length === 0 && /address already in use|EADDRINUSE/i.test(result.stderr);
}

async function runInspectorHandoff(cliPath: string): Promise<{ result: RunResult; port: number }> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const port = await findFreePort();
		const child = spawn(process.execPath, [`--inspect-brk=127.0.0.1:${port}`, "--import", "tsx", cliPath, "--help"], {
			detached: process.platform !== "win32",
			env: sanitizedChildEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			const result = await driveRun(child);
			if (isPrelaunchCollision(result)) continue;
			return { result, port };
		} finally {
			await terminateProcessTree(child);
		}
	}
	throw new Error("Inspector port collided before launch on every attempt");
}

test("closes only the debugger socket acknowledged by its own resume", async () => {
	const originalWebSocket = globalThis.WebSocket;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		exitCode: null,
		stderr,
		stdout,
	}) as unknown as ChildProcessByStdio<null, Readable, Readable>;
	FakeInspectorSocket.instances = [];
	globalThis.WebSocket = FakeInspectorSocket as unknown as typeof WebSocket;
	const run = driveRun(child);

	try {
		stderr.write(`Debugger listening on ws://127.0.0.1:60457/first
`);
		const first = FakeInspectorSocket.instances[0];
		expect(first).toBeDefined();
		first?.open();
		first?.receive({ id: 1 });
		first?.receive({ method: "Debugger.paused" });
		first?.receive({ id: 3 });
		expect(first?.closeCalls).toBe(1);

		stderr.write(`Waiting for the debugger to disconnect...
`);
		stderr.write(`Debugger listening on ws://127.0.0.1:60457/second
`);
		const second = FakeInspectorSocket.instances[1];
		expect(second).toBeDefined();
		second?.open();
		second?.receive({ id: 1 });
		second?.receive({ method: "Debugger.paused" });
		stderr.write(`Debugger attached.
`);
		expect(second?.closeCalls).toBe(0);
		second?.receive({ id: 3 });
		expect(second?.closeCalls).toBe(1);
	} finally {
		child.emit("close", 0);
		globalThis.WebSocket = originalWebSocket;
	}

	const result = await run;
	expect(result.states).toHaveLength(2);
	for (const state of result.states) {
		expect(state.enabled).toBe(true);
		expect(state.paused).toBe(true);
		expect(state.resumed).toBe(true);
	}
});

test("classifies only pre-endpoint address conflicts as retryable", () => {
	const collision = { code: 1, stdout: "", stderr: "EADDRINUSE", states: [] };
	const handoffFailure = {
		...collision,
		states: [{ url: "ws://127.0.0.1", enabled: true, paused: true, resumed: true }],
	};
	expect(isPrelaunchCollision(collision)).toBe(true);
	expect(isPrelaunchCollision(handoffFailure)).toBe(false);
});

test("hands a fixed inspect-brk endpoint across two fully resumed debugger sessions", async () => {
	const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
	const { result, port } = await runInspectorHandoff(cliPath);
	const endpoints = [...result.stderr.matchAll(/Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//g)].map(
		(match) => match[1],
	);

	expect(result.code).toBe(0);
	expect(result.stdout).toContain("Usage:");
	expect(result.stderr).not.toContain("address already in use");
	expect(endpoints).toHaveLength(2);
	expect(new Set(endpoints)).toEqual(new Set([String(port)]));
	expect(result.states).toHaveLength(2);
	for (const state of result.states) {
		expect(state.error).toBeUndefined();
		expect(state.enabled).toBe(true);
		expect(state.paused).toBe(true);
		expect(state.resumed).toBe(true);
	}
}, 180_000);
