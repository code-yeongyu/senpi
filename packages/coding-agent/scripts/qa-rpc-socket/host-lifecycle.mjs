#!/usr/bin/env node
/**
 * Real-CLI QA for the shared RPC socket host lifecycle policy (idle exit +
 * cold start). Uses the packaged QA harness: a fake OpenAI-compatible model
 * server whose responses can be held, the real `senpi --mode rpc --listen`
 * socket host started through ensureHost(), and short idle windows.
 *
 * Scenarios:
 *   1. transient host with a short idle window: no connections, no turns →
 *      exits cleanly (pidfile/settings/socket removed), then the next ensure
 *      transparently starts a fresh host with a NEW pid that serves traffic.
 *   2. active turn: a held model response keeps a turn running past the window
 *      with the client detached → host must stay alive; completing the turn
 *      lets the idle window close the host afterwards.
 *   3. persistent cold start (env override): the host must never idle-exit.
 *   4. supervisor kill -9: the internal RPC host is bound to the supervisor's
 *      lifetime by an inherited pipe, so an uncatchable supervisor death still
 *      reaps the host and removes its private internal directory.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../src/config.ts";
import { processMatchesPidFile } from "../../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths, ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { HOST_COLD_START_ENV } from "../../src/modes/rpc/host-lifecycle.ts";
import {
	cleanupAllAndWait,
	hermeticEnv,
	installCleanupHooks,
	startFakeModelServer,
	writeMockModelsJson,
} from "../qa-app-server/lib/env.mjs";
import { trackCloser, untrackCloser } from "../qa-app-server/lib/cleanup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = flag("--out");
const transcript = [];
const roots = [];
const managedHosts = [];
installCleanupHooks();

async function main() {
	try {
		await scenarioTransientIdleExitAndReEnsure();
		await scenarioActiveTurnHoldsHostOpen();
		await scenarioPersistentNeverIdleExits();
		await scenarioSupervisorKillReapsInternalHost();
		transcript.push("PASS host-lifecycle");
	} catch (error) {
		transcript.push(`FAIL host-lifecycle: ${error instanceof Error ? error.stack : String(error)}`);
		process.exitCode = 1;
	} finally {
		for (const host of managedHosts.splice(0)) await stopHost(host).catch(() => undefined);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		await cleanupAllAndWait();
		transcript.push("cleanup=hosts,sockets,scratch-removed");
		if (outPath) writeFileSync(outPath, `${transcript.join("\n")}\n`);
		if (transcript.length > 0) process.stdout.write(`${transcript.join("\n")}\n`);
		process.exit(process.exitCode ?? 0);
	}
}

async function scenarioTransientIdleExitAndReEnsure() {
	const qa = makeScratch("transient");
	const first = await ensure(qa, { idleExitMs: 1500 });
	transcript.push(`assert transient-start pid=${first.pid} reused=false settings=${JSON.stringify(first.settings)}`);
	await waitForHostExit(qa, first.pid);
	assertStateRemoved(qa);
	transcript.push("assert idle-exit=clean pidfile-settings-socket-removed");

	const second = await ensure(qa, { idleExitMs: 1500 });
	if (second.pid === first.pid) throw new Error(`ensure after idle exit reused dead pid ${first.pid}`);
	if (second.reused) throw new Error("ensure after idle exit reported reused=true");
	const info = await protocolInfo(qa.socket);
	if (info.data?.serverVersion !== VERSION) {
		throw new Error(`fresh host served wrong version: ${JSON.stringify(info.data)}`);
	}
	transcript.push(`assert re-ensure=new-pid pid=${second.pid} serves=get_protocol_info`);
	await stopHost(second);
}

async function scenarioActiveTurnHoldsHostOpen() {
	const qa = makeScratch("turn");
	const fake = await startFakeModelServer([{ hold: true }]);
	writeMockModelsJson(qa.agentDir, fake);
	try {
		const ensured = await ensure(qa, {
			idleExitMs: 1500,
			hostArgs: ["--provider", "mock", "--model", "mock-model"],
		});
		const client = await SocketRpcClient.connect(qa.socket);
		const opened = await client.request({ type: "open_session", cwd: qa.cwd });
		const sessionId = opened.data?.sessionId;
		if (typeof sessionId !== "string") throw new Error(`open_session missing id: ${JSON.stringify(opened)}`);
		const started = client.waitFor((message) => message.type === "agent_start" && message.sessionId === sessionId);
		await client.request({ type: "prompt", sessionId, message: "hold this turn open past the idle window" });
		await started;
		client.close();
		transcript.push("assert turn-open=client-detached turn-observed=agent_start");
		await delay(4500);
		if (!(await processMatchesPidFile(ensured.pidFile))) {
			throw new Error(`host exited while a turn was active and no client was attached\n${readSupervisorStderr(qa)}`);
		}
		transcript.push("assert active-turn-past-window=still-alive");

		fake.releaseHolds();
		await waitForHostExit(qa, ensured.pid);
		assertStateRemoved(qa);
		transcript.push("assert turn-completed=idle-exit-follows");
	} finally {
		await fake.stop().catch(() => undefined);
	}
}

async function scenarioPersistentNeverIdleExits() {
	const qa = makeScratch("persist");
	const ensured = await ensure(qa, { idleExitMs: 1500, env: { [HOST_COLD_START_ENV]: "persistent" } });
	await delay(4500);
	if (!(await processMatchesPidFile(ensured.pidFile))) {
		throw new Error(`persistent host idle-exited despite coldStart=persistent\n${readSupervisorStderr(qa)}`);
	}
	transcript.push("assert persistent-past-window=still-alive");
	await stopHost(ensured);
	transcript.push("assert persistent-sigterm=clean-stop");
}

async function scenarioSupervisorKillReapsInternalHost() {
	const qa = makeScratch("kill9");
	const internalBefore = new Set(internalHostDirs());
	// A long idle window guarantees only the lifetime binding - never idle exit -
	// can reap the internal host during this scenario.
	const ensured = await ensure(qa, { idleExitMs: 600_000 });
	const children = await waitForChildren(ensured.pid);
	if (children.length === 0) throw new Error(`supervisor ${ensured.pid} spawned no internal host`);
	const internalDirs = internalHostDirs().filter((dir) => !internalBefore.has(dir));
	transcript.push(`assert kill9-setup supervisor=${ensured.pid} internal-host=${children.join(",")}`);

	process.kill(ensured.pid, "SIGKILL");
	const started = Date.now();
	let survivors = children.filter(processAlive);
	while (Date.now() - started <= 10_000 && survivors.length > 0) {
		await delay(200);
		survivors = children.filter(processAlive);
	}
	if (survivors.length > 0) {
		for (const pid of survivors) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		throw new Error(`internal host ${survivors.join(",")} survived supervisor kill -9 as an orphan`);
	}
	transcript.push(`assert kill9-orphan=none internal-host-exited-in=${Date.now() - started}ms`);

	const leaked = internalDirs.filter((dir) => existsSync(dir));
	for (const dir of leaked) rmSync(dir, { recursive: true, force: true });
	if (leaked.length > 0) throw new Error(`internal host directories leaked after supervisor kill -9: ${leaked.join(", ")}`);
	transcript.push("assert kill9-cleanup=private-internal-dir-removed");
	rmSync(qa.socket, { force: true });
}

function internalHostDirs() {
	return readdirSync(tmpdir())
		.filter((name) => name.startsWith("senpi-rpc-host-internal-"))
		.map((name) => join(tmpdir(), name));
}

async function waitForChildren(pid) {
	const deadline = Date.now() + 10_000;
	while (Date.now() <= deadline) {
		const children = childPids(pid);
		if (children.length > 0) return children;
		await delay(100);
	}
	return [];
}

function childPids(pid) {
	try {
		return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
			.split("\n")
			.map((value) => Number(value.trim()))
			.filter((value) => Number.isInteger(value) && value > 0);
	} catch {
		return [];
	}
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function makeScratch(label) {
	const root = mkdtempSync(join(tmpdir(), `senpi-hlcqa-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	for (const path of [agentDir, sessionDir, cwd]) mkdirSync(path, { recursive: true });
	return { root, agentDir, sessionDir, cwd, socket: join(root, "rpc.sock") };
}

async function ensure(qa, { idleExitMs, hostArgs = [], env = {} }) {
	const ensured = await ensureHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		policy: { idleExitMs },
		_test: {
			readinessTimeoutMs: 60_000,
			env: {
				...hermeticEnv({
					PI_OFFLINE: "1",
					PI_TELEMETRY: "0",
					SENPI_RUNTIME: "node",
					SENPI_CODING_AGENT_DIR: qa.agentDir,
					SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
				}),
				...env,
			},
			hostArgs,
			spawn: {
				command: process.execPath,
				args: [join(here, "..", "..", "src", "modes", "rpc", "host-lifecycle.ts"), "--socket", qa.socket, ...hostArgs],
			},
		},
	});
	const paths = createHostDaemonPaths(qa.agentDir);
	const tracked = {
		qa,
		pidFile: JSON.parse(readFileSync(paths.pidFile, "utf8")),
		pid: ensured.pid,
		settings: JSON.parse(readFileSync(paths.settingsFile, "utf8")),
	};
	managedHosts.push(tracked);
	return tracked;
}

async function stopHost(host) {
	if (!(await processMatchesPidFile(host.pidFile))) return;
	process.kill(host.pidFile.pid, "SIGTERM");
	const deadline = Date.now() + 10_000;
	while (Date.now() <= deadline) {
		if (!(await processMatchesPidFile(host.pidFile))) return;
		await delay(100);
	}
	process.kill(host.pidFile.pid, "SIGKILL");
}

async function waitForHostExit(qa, pid) {
	const paths = createHostDaemonPaths(qa.agentDir);
	const pidFile = JSON.parse(readFileSync(paths.pidFile, "utf8"));
	const deadline = Date.now() + 20_000;
	while (Date.now() <= deadline) {
		if (!(await processMatchesPidFile(pidFile)) && !existsSync(paths.pidFile)) return;
		await delay(100);
	}
	throw new Error(`host pid ${pid} did not idle-exit within 20s\n${readSupervisorStderr(qa)}`);
}

function assertStateRemoved(qa) {
	const paths = createHostDaemonPaths(qa.agentDir);
	for (const [label, path] of [
		["pidfile", paths.pidFile],
		["settings", paths.settingsFile],
		["socket", qa.socket],
	]) {
		if (existsSync(path)) throw new Error(`${label} survived host exit: ${path}`);
	}
}

function readSupervisorStderr(qa) {
	try {
		return `[supervisor stderr]\n${readFileSync(createHostDaemonPaths(qa.agentDir).stderrLog, "utf8")}`;
	} catch {
		return "[supervisor stderr unavailable]";
	}
}

function protocolInfo(socketPath) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		const timer = setTimeout(() => finish(new Error("protocol info timeout")), 10_000);
		const finish = (error, value) => {
			clearTimeout(timer);
			socket.destroy();
			if (error || value === undefined) reject(error ?? new Error("no protocol info"));
			else resolve(value);
		};
		socket.once("connect", () => socket.write('{"id":"qa-probe","type":"get_protocol_info"}\n'));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline !== -1) finish(undefined, JSON.parse(buffer.slice(0, newline)));
		});
		socket.once("error", finish);
	});
}

class SocketRpcClient {
	constructor(socket) {
		this.socket = socket;
		this.cleanupSocket = () => socket.destroy();
		trackCloser(this.cleanupSocket);
		this.messages = [];
		this.waiters = new Set();
		this.buffer = "";
		socket.on("data", (chunk) => this.read(chunk.toString("utf8")));
	}

	static async connect(socketPath) {
		const socket = createConnection(socketPath);
		await new Promise((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new SocketRpcClient(socket);
	}

	async request(command, timeoutMs = 30_000) {
		const id = `qa-${this.messages.length + 1}`;
		const mark = this.messages.length;
		this.write({ id, ...command });
		return this.waitFor((message) => message.type === "response" && message.id === id, mark, timeoutMs);
	}

	write(value) {
		this.socket.write(`${JSON.stringify(value)}\n`);
	}

	waitFor(predicate, fromIndex = 0, timeoutMs = 30_000) {
		const existing = this.messages.slice(fromIndex).find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = { predicate, resolve, timer: undefined };
			waiter.timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error("Timed out waiting for RPC record"));
			}, timeoutMs);
			this.waiters.add(waiter);
		});
	}

	close() {
		untrackCloser(this.cleanupSocket);
		this.cleanupSocket();
	}

	read(text) {
		this.buffer += text;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			this.messages.push(message);
			transcript.push(`[client <<] ${line.slice(0, 160)}`);
			for (const waiter of [...this.waiters]) {
				if (!waiter.predicate(message)) continue;
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

await main();
