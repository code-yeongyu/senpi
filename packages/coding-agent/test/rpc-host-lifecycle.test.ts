import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { processMatchesPidFile, readProcessStartTime } from "../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths, ensureHost, type HostLifecyclePolicyInput } from "../src/modes/rpc/host-ensure.ts";
import {
	DEFAULT_HOST_IDLE_EXIT_MS,
	HOST_COLD_START_ENV,
	HOST_IDLE_EXIT_MS_ENV,
	IdleExitDecider,
	resolveHostPolicy,
} from "../src/modes/rpc/host-lifecycle.ts";
import {
	armHostWatchdog,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_PPID_ENV,
	readHostWatchdogConfig,
} from "../src/modes/rpc/host-watchdog.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";

const roots: string[] = [];
const peers: JsonlPeer[] = [];
const models: HeldAnthropicModel[] = [];
const managed: Array<{ pidFile: { pid: number; processStartTime: string }; pidFilePath: string }> = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const model of models.splice(0)) await model.close();
	for (const entry of managed.splice(0)) await stopHostProcess(entry.pidFile, entry.pidFilePath);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 30_000);

type RecordValue = Record<string, unknown>;

interface Scratch {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly cwd: string;
	readonly socket: string;
	readonly pidFilePath: string;
}

describe("host lifecycle policy resolution", () => {
	it("documents the default policy: transient cold start with a 15 minute idle window", () => {
		expect(resolveHostPolicy(undefined, {})).toEqual({
			coldStart: "transient",
			idleExitMs: DEFAULT_HOST_IDLE_EXIT_MS,
		});
		expect(DEFAULT_HOST_IDLE_EXIT_MS).toBe(15 * 60_000);
	});

	it("reads the policy from settings.json", () => {
		expect(resolveHostPolicy({ coldStart: "persistent", idleExitMs: 42 }, {})).toEqual({
			coldStart: "persistent",
			idleExitMs: 42,
		});
	});

	it("env overrides beat settings.json and invalid values fall through", () => {
		expect(
			resolveHostPolicy({ coldStart: "persistent", idleExitMs: 42 }, { [HOST_COLD_START_ENV]: "transient" }),
		).toEqual({
			coldStart: "transient",
			idleExitMs: 42,
		});
		expect(resolveHostPolicy({ coldStart: "transient" }, { [HOST_IDLE_EXIT_MS_ENV]: "7" })).toEqual({
			coldStart: "transient",
			idleExitMs: 7,
		});
		expect(resolveHostPolicy({ coldStart: "persistent" }, { [HOST_COLD_START_ENV]: "nonsense" })).toEqual({
			coldStart: "persistent",
			idleExitMs: DEFAULT_HOST_IDLE_EXIT_MS,
		});
		expect(resolveHostPolicy({ idleExitMs: -5 }, { [HOST_IDLE_EXIT_MS_ENV]: "0" })).toEqual({
			coldStart: "transient",
			idleExitMs: DEFAULT_HOST_IDLE_EXIT_MS,
		});
	});
});

describe("idle exit decision core", () => {
	function fakeClock(start: number): { now: () => number; advance: (ms: number) => void } {
		let current = start;
		return { now: () => current, advance: (ms: number) => (current += ms) };
	}

	it("exits only after the window elapsed with continuous idle", () => {
		const clock = fakeClock(1_000);
		const decider = new IdleExitDecider(600, clock.now);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		clock.advance(599);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		clock.advance(1);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("exit");
	});

	it("activity resets the window; a connection or turn holds the host open", () => {
		const clock = fakeClock(0);
		const decider = new IdleExitDecider(600, clock.now);
		decider.update({ connections: 0, activeTurns: 0 });
		clock.advance(500);
		expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
		clock.advance(60_000);
		expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
		expect(decider.update({ connections: 0, activeTurns: 2 })).toBe("active");
		clock.advance(60_000);
		expect(decider.update({ connections: 0, activeTurns: 2 })).toBe("active");
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		clock.advance(599);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		clock.advance(1);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("exit");
	});

	it("an infinite window (persistent cold start) never exits", () => {
		const clock = fakeClock(0);
		const decider = new IdleExitDecider(Number.POSITIVE_INFINITY, clock.now);
		decider.update({ connections: 0, activeTurns: 0 });
		clock.advance(Number.MAX_SAFE_INTEGER);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
	});
});

describe("ensureHost-spawned host lifecycle", () => {
	it("exits cleanly after the idle window with no connections and no active turns", async () => {
		const qa = scratch("idle");
		const internalBefore = listInternalSocketDirs();
		const ensured = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 } });
		expect(ensured.reused).toBe(false);
		const entry = currentManaged();
		await waitForHostExit(entry);
		expect(existsSync(entry.pidFilePath)).toBe(false);
		expect(existsSync(createHostDaemonPaths(qa.agentDir).settingsFile)).toBe(false);
		expect(existsSync(qa.socket)).toBe(false);
		expect(listInternalSocketDirs().filter((dir) => !internalBefore.includes(dir))).toEqual([]);
	}, 45_000);

	it("does not exit while a client is attached, then exits after it detaches", async () => {
		const qa = scratch("conn");
		await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 } });
		const entry = currentManaged();
		const peer = await JsonlPeer.connect(qa.socket);
		await delay(2_000);
		expect(await hostAlive(entry.pidFile)).toBe(true);
		peer.destroy();
		await waitForHostExit(entry);
	}, 45_000);

	it("does not exit while a turn is active even with no connections; exits after the turn settles", async () => {
		const qa = scratch("turn");
		const model = await HeldAnthropicModel.start();
		models.push(model);
		writeRpcModelsJson(qa.agentDir, model.origin);
		await ensureLifecycleHost(qa, {
			policy: { idleExitMs: 800 },
			hostArgs: ["--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
		});
		const entry = currentManaged();
		const peer = await JsonlPeer.connect(qa.socket);
		const opened = await peer.request({ id: "open", type: "open_session", cwd: qa.cwd });
		const sessionId = openedSessionId(opened);
		const agentStart = peer.waitFor((value) => value.type === "agent_start" && value.sessionId === sessionId);
		await peer.request({ id: "prompt", type: "prompt", sessionId, message: "hold this turn open" });
		await agentStart;
		peer.destroy();
		await delay(2_500);
		expect(await hostAlive(entry.pidFile)).toBe(true);
		model.release();
		await waitForHostExit(entry, 20_000);
	}, 60_000);

	it("starts a fresh host transparently on the next ensure after an idle exit", async () => {
		const qa = scratch("ensure");
		const first = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 } });
		const entry = currentManaged();
		await waitForHostExit(entry);
		const second = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600 } });
		expect(second.reused).toBe(false);
		expect(second.pid).not.toBe(first.pid);
		const info = await protocolInfo(qa.socket);
		expect(info.data).toMatchObject({ serverVersion: VERSION, mode: "multi" });
	}, 60_000);

	it("persistent cold start never idle-exits (env override beats settings)", async () => {
		const qa = scratch("persist");
		await ensureLifecycleHost(qa, {
			policy: { idleExitMs: 600 },
			env: { [HOST_COLD_START_ENV]: "persistent" },
		});
		const entry = currentManaged();
		await delay(2_500);
		expect(await hostAlive(entry.pidFile)).toBe(true);
		process.kill(entry.pidFile.pid, "SIGTERM");
		await waitForHostExit(entry);
	}, 45_000);

	it("reaps the internal host when the supervisor is SIGKILLed (no catchable-signal path)", async () => {
		const qa = scratch("kill9");
		const internalBefore = listInternalSocketDirs();
		// A long idle window leaves the supervisor-lifetime binding as the only thing
		// that can reap the internal host during this test.
		const ensured = await ensureLifecycleHost(qa, { policy: { idleExitMs: 600_000 } });
		const internalHosts = await waitForChildPids(ensured.pid);
		expect(internalHosts.length).toBeGreaterThan(0);
		const leakedDirs = listInternalSocketDirs().filter((dir) => !internalBefore.includes(dir));

		process.kill(ensured.pid, "SIGKILL");
		await waitForPidsGone(internalHosts, 10_000);
		expect(internalHosts.filter(processAlive)).toEqual([]);
		expect(leakedDirs.filter((dir) => existsSync(join(tmpdir(), dir)))).toEqual([]);
	}, 60_000);
});

describe("host watchdog configuration", () => {
	it("is inert unless the supervisor asks for a lifetime binding", () => {
		expect(readHostWatchdogConfig({})).toBeUndefined();
		expect(readHostWatchdogConfig({ [HOST_SCRATCH_DIR_ENV]: "/tmp/whatever" })).toBeUndefined();
		expect(readHostWatchdogConfig({ [HOST_WATCH_FD_ENV]: "not-a-number" })).toBeUndefined();
		expect(readHostWatchdogConfig({ [HOST_WATCH_FD_ENV]: "0" })).toBeUndefined();
		let fired = false;
		const disarm = armHostWatchdog(undefined, () => {
			fired = true;
		});
		disarm();
		expect(fired).toBe(false);
	});

	it("reads the fd, ppid and scratch directory the supervisor passes", () => {
		expect(
			readHostWatchdogConfig({
				[HOST_WATCH_FD_ENV]: "3",
				[HOST_WATCH_PPID_ENV]: "4242",
				[HOST_SCRATCH_DIR_ENV]: "/tmp/senpi-rpc-host-internal-abc",
			}),
		).toEqual({ fd: 3, ppid: 4242, scratchDir: "/tmp/senpi-rpc-host-internal-abc" });
	});

	it("fires on inherited-pipe EOF and removes the supervisor's private directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-hlc-wd-"));
		roots.push(dir);
		const scratchDir = join(dir, "internal");
		mkdirSync(scratchDir, { recursive: true });
		const fifo = join(dir, "pipe");
		execFileSync("mkfifo", [fifo]);
		// Opening both ends keeps the fifo alive until the write end is closed, which
		// is exactly the EOF the supervisor's death produces on the inherited pipe.
		const writeEnd = openSync(fifo, "w+");
		const readEnd = openSync(fifo, "r");
		// armHostWatchdog takes ownership of the read end, so the test only closes
		// the write end - that close is what the supervisor's death looks like.
		const reason = new Promise<string>((resolve) => {
			armHostWatchdog({ fd: readEnd, scratchDir }, resolve);
		});
		closeSync(writeEnd);
		expect(await reason).toContain("closed");
		expect(existsSync(scratchDir)).toBe(false);
	}, 15_000);
});

function scratch(label: string): Scratch {
	// Unix socket paths must stay under the platform sun_path limit (104 bytes on
	// macOS), so the scratch prefix and labels are kept deliberately short.
	const root = mkdtempSync(join(tmpdir(), `senpi-hlc-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return {
		root,
		agentDir,
		sessionDir,
		cwd,
		socket: join(root, "rpc.sock"),
		pidFilePath: createHostDaemonPaths(agentDir).pidFile,
	};
}

function listInternalSocketDirs(): string[] {
	return readdirSync(tmpdir()).filter((name) => name.startsWith("senpi-rpc-host-internal-"));
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForChildPids(pid: number, timeoutMs = 10_000): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		let output = "";
		try {
			output = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
		} catch {
			output = "";
		}
		const children = output
			.split("\n")
			.map((value) => Number(value.trim()))
			.filter((value) => Number.isInteger(value) && value > 0);
		if (children.length > 0) return children;
		await delay(100);
	}
	return [];
}

async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (!pids.some(processAlive)) return;
		await delay(100);
	}
}

function hostLifecycleEntry(): string {
	return join(import.meta.dirname, "..", "src", "modes", "rpc", "host-lifecycle.ts");
}

async function ensureLifecycleHost(
	qa: Scratch,
	options: { policy?: HostLifecyclePolicyInput; hostArgs?: string[]; env?: Record<string, string> } = {},
) {
	const hostArgs = options.hostArgs ?? [];
	try {
		const ensured = await ensureHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			policy: options.policy,
			_test: {
				readinessTimeoutMs: 30_000,
				env: {
					...hermeticProviderEnv(),
					PI_OFFLINE: "1",
					PI_TELEMETRY: "0",
					SENPI_RUNTIME: "node",
					SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
					...(options.env ?? {}),
				},
				hostArgs,
				spawn: { command: process.execPath, args: [hostLifecycleEntry(), "--socket", qa.socket, ...hostArgs] },
			},
		});
		managed.push({
			pidFile: JSON.parse(await readFile(qa.pidFilePath, "utf8")) as { pid: number; processStartTime: string },
			pidFilePath: qa.pidFilePath,
		});
		return ensured;
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n[supervisor stderr]\n${readSupervisorStderr(qa)}`,
		);
	}
}

function readSupervisorStderr(qa: Scratch): string {
	try {
		return readFileSync(createHostDaemonPaths(qa.agentDir).stderrLog, "utf8");
	} catch {
		return "<no supervisor stderr log>";
	}
}

function currentManaged(): { pidFile: { pid: number; processStartTime: string }; pidFilePath: string } {
	const entry = managed.at(-1);
	if (!entry) throw new Error("no managed host for this test");
	return entry;
}

async function hostAlive(pidFile: { pid: number; processStartTime: string }): Promise<boolean> {
	return processMatchesPidFile(pidFile, readProcessStartTime);
}

async function waitForHostExit(
	entry: { pidFile: { pid: number; processStartTime: string }; pidFilePath: string },
	timeoutMs = 12_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const running = await processMatchesPidFile(entry.pidFile, readProcessStartTime);
		if (!running && !existsSync(entry.pidFilePath)) return;
		await delay(50);
	}
	throw new Error(`RPC socket host pid ${entry.pidFile.pid} did not exit within ${timeoutMs}ms`);
}

async function stopHostProcess(pidFile: { pid: number; processStartTime: string }, pidFilePath: string): Promise<void> {
	try {
		if (await hostAlive(pidFile)) {
			signalIfAlive(pidFile.pid, "SIGTERM");
			await waitForHostExit({ pidFile, pidFilePath }, 5_000).catch(async () => {
				// A host that idle-exits on its own between the SIGTERM and this
				// escalation is a normal teardown, not a failure: signal only if the
				// pid is still ours, so teardown can never fail with ESRCH.
				signalIfAlive(pidFile.pid, "SIGKILL");
				await waitForHostExit({ pidFile, pidFilePath }, 2_000).catch(() => undefined);
			});
		}
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

function openedSessionId(response: RecordValue): string {
	const data = response.data as RecordValue | undefined;
	if (typeof data?.sessionId !== "string")
		throw new Error(`open_session missing session id: ${JSON.stringify(response)}`);
	return data.sessionId;
}

async function protocolInfo(socketPath: string): Promise<RecordValue> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		const timer = setTimeout(() => finish(new Error("protocol info timeout")), 5_000);
		const finish = (error?: Error, value?: RecordValue) => {
			clearTimeout(timer);
			socket.destroy();
			if (error || value === undefined) reject(error ?? new Error("no protocol info"));
			else resolve(value);
		};
		socket.once("connect", () => socket.write('{"id":"probe","type":"get_protocol_info"}\n'));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline !== -1) finish(undefined, JSON.parse(buffer.slice(0, newline)) as RecordValue);
		});
		socket.once("error", finish);
	});
}

class JsonlPeer {
	readonly messages: RecordValue[] = [];
	private buffer = "";
	private readonly socket: Socket;
	private readonly waiters = new Set<{
		predicate: (value: RecordValue) => boolean;
		resolve: (value: RecordValue) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk) => this.read(chunk.toString("utf8")));
	}

	static async connect(socketPath: string): Promise<JsonlPeer> {
		const socket = createConnection(socketPath);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const peer = new JsonlPeer(socket);
		peers.push(peer);
		return peer;
	}

	request(command: RecordValue, timeoutMs = 15_000): Promise<RecordValue> {
		const id = command.id;
		const response = this.waitFor((value) => value.type === "response" && value.id === id, timeoutMs);
		this.write(command);
		return response;
	}

	write(value: unknown): void {
		this.socket.write(`${JSON.stringify(value)}\n`);
	}

	waitFor(predicate: (value: RecordValue) => boolean, timeoutMs = 15_000): Promise<RecordValue> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error("Timed out waiting for RPC record"));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	destroy(): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve({ type: "peer-closed" });
		}
		this.waiters.clear();
		this.socket.destroy();
	}

	private read(text: string): void {
		this.buffer += text;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line) as RecordValue;
			this.messages.push(message);
			for (const waiter of [...this.waiters]) {
				if (!waiter.predicate(message)) continue;
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
	}
}

/**
 * Anthropic-Messages fake whose single response is held until release(), so a
 * real agent turn stays active past any idle window under test.
 */
class HeldAnthropicModel {
	private readonly server: HttpServer;
	private readonly releaseHolds: () => void;

	private constructor(server: HttpServer, releaseHolds: () => void) {
		this.server = server;
		this.releaseHolds = releaseHolds;
	}

	static async start(): Promise<HeldAnthropicModel> {
		let releaseHolds: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			releaseHolds = resolve;
		});
		const server = createHttpServer((req, res) => {
			req.resume();
			req.on("end", () => {
				void held.then(() => writeHeldAnthropicResponse(res));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return new HeldAnthropicModel(server, releaseHolds);
	}

	get origin(): string {
		const address = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${address.port}`;
	}

	release(): void {
		this.releaseHolds();
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}
}

function writeHeldAnthropicResponse(res: ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const send = (event: string, data: Record<string, unknown>): void => {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
	};
	send("message_start", {
		message: {
			id: "msg-held-rpc",
			type: "message",
			role: "assistant",
			model: MOCK_MODEL,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	});
	send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "held turn complete" } });
	send("content_block_stop", { index: 0 });
	send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
	send("message_stop", {});
	res.end();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
