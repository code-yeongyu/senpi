import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import {
	processMatchesPidFile,
	readProcessStartTime,
	waitForStartTime,
} from "../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths, defaultHostLaunch, ensureHost } from "../src/modes/rpc/host-ensure.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const fixture = join(import.meta.dirname, "fixtures", "rpc-host-fixture.mjs");

afterEach(async () => {
	for (const child of children.splice(0)) await stopChild(child);
	for (const root of roots.splice(0)) {
		await stopManagedRoot(root);
		await rm(root, { recursive: true, force: true });
	}
});

describe("ensureHost", () => {
	it("serializes concurrent starts for one socket across agent directories", async () => {
		const qa = await scratch("cross-agent-race");
		const secondAgentDir = join(qa.root, "other-agent");
		let releaseFirst!: () => void;
		let signalFirstLocked!: () => void;
		const firstLocked = new Promise<void>((resolve) => (releaseFirst = resolve));
		const firstAcquired = new Promise<void>((resolve) => (signalFirstLocked = resolve));
		const first = ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: {
				afterLockAcquired: async () => {
					signalFirstLocked();
					await firstLocked;
				},
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, "multi_session,extension_events", "answer"],
				},
			},
		});
		await firstAcquired;
		const second = ensureHost({
			agentDir: secondAgentDir,
			socket: qa.socket,
			_test: {
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, "multi_session,extension_events", "answer"],
				},
			},
		});
		releaseFirst();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.reused).toBe(false);
		expect(secondResult).toMatchObject({ socket: qa.socket, reused: true });
	}, 45_000);

	it("starts a missing host and reuses it on the second call", async () => {
		const qa = await scratch("start-reuse");
		const first = await ensureFixtureHost(qa);
		const second = await ensureFixtureHost(qa);
		expect(first).toEqual({ pid: expect.any(Number), socket: qa.socket, reused: false });
		expect(second).toEqual({ pid: first.pid, socket: qa.socket, reused: true });
		expect((await protocolInfo(qa.socket)).data).toMatchObject({ serverVersion: VERSION });
	});

	it("attaches to a compatible unmanaged host", async () => {
		const qa = await scratch("compatible-unmanaged");
		const child = spawn(process.execPath, [fixture, qa.socket, VERSION, "multi_session,extension_events", "answer"], {
			detached: true,
			stdio: "ignore",
		});
		children.push(child);
		if (child.pid === undefined) throw new Error("fixture did not spawn");
		await waitForProtocol(qa.socket);
		const result = await ensureFixtureHost(qa);
		expect(result.reused).toBe(true);
		expect(result.pid).toBe(0);
	});

	it("replaces a host answering with the wrong server version", async () => {
		const qa = await scratch("wrong-version");
		const old = await startManagedFixture(qa, "wrong-version", "multi_session,extension_events");
		const result = await ensureFixtureHost(qa);
		expect(result.reused).toBe(false);
		expect(result.pid).not.toBe(old.pid);
		await expectGone(old.pidFile);
	});

	it("replaces a host missing a required capability", async () => {
		const qa = await scratch("missing-capability");
		const old = await startManagedFixture(qa, VERSION, "multi_session");
		const result = await ensureFixtureHost(qa);
		expect(result.reused).toBe(false);
		expect(result.pid).not.toBe(old.pid);
		await expectGone(old.pidFile);
	});

	it("cleans a stale dead pidfile and starts fresh", async () => {
		const qa = await scratch("stale-pidfile");
		const paths = createHostDaemonPaths(qa.agentDir);
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.pidFile, `${JSON.stringify({ pid: 999_999_999, processStartTime: "dead" })}\n`);
		await writeFile(paths.settingsFile, "stale");
		const result = await ensureFixtureHost(qa);
		expect(result.reused).toBe(false);
		expect(result.pid).not.toBe(999_999_999);
		expect(JSON.parse(await readFile(paths.settingsFile, "utf8"))).toMatchObject({ socket: qa.socket });
	});

	it("escalates to SIGKILL when the replaced process ignores SIGTERM", async () => {
		const qa = await scratch("sigkill");
		const old = await startManagedFixture(qa, "wrong-version", "multi_session,extension_events", "ignore-term");
		const startedAt = Date.now();
		const result = await ensureFixtureHost(qa, { stopTimeoutMs: 200 });
		expect(result.pid).not.toBe(old.pid);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		await expectGone(old.pidFile);
	});

	it("fails within the readiness budget and includes stderr diagnostics", async () => {
		const qa = await scratch("readiness-failure");
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 300,
				spawn: {
					command: process.execPath,
					args: ["-e", "process.stderr.write('fixture readiness diagnostic\\n'); setInterval(() => {}, 1000)"],
				},
			}),
		).rejects.toThrow(/did not answer get_protocol_info.*fixture readiness diagnostic/s);
		const paths = createHostDaemonPaths(qa.agentDir);
		await expect(access(paths.pidFile)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(qa.socket)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);
});

describe("defaultHostLaunch", () => {
	it("re-enters through the internal supervisor route in compiled binaries", () => {
		expect(defaultHostLaunch("/tmp/qa.sock", ["--provider", "mock"], true)).toEqual({
			command: process.execPath,
			args: ["--internal-rpc-host-supervisor", "--socket", "/tmp/qa.sock", "--provider", "mock"],
		});
	});

	it("re-enters through the host-lifecycle script outside compiled binaries", () => {
		const launch = defaultHostLaunch("/tmp/qa.sock", ["--provider", "mock"], false);
		expect(launch.command).toBe(process.execPath);
		const args = launch.args.slice(process.execArgv.length);
		expect(args[0]).toMatch(/host-lifecycle\.(ts|js)$/);
		expect(args.slice(1)).toEqual(["--socket", "/tmp/qa.sock", "--provider", "mock"]);
	});
});

type Qa = { root: string; agentDir: string; socket: string };
type Overrides = { readinessTimeoutMs?: number; stopTimeoutMs?: number; spawn?: { command: string; args: string[] } };

async function scratch(label: string): Promise<Qa> {
	const root = await mkdtemp(join(tmpdir(), `senpi-host-ensure-${label}-`));
	roots.push(root);
	return { root, agentDir: join(root, "agent"), socket: join(root, "rpc.sock") };
}

function ensureFixtureHost(qa: Qa, overrides: Overrides = {}) {
	return ensureHost({
		agentDir: qa.agentDir,
		socket: qa.socket,
		_test: {
			readinessTimeoutMs: overrides.readinessTimeoutMs,
			stopTimeoutMs: overrides.stopTimeoutMs,
			spawn: overrides.spawn ?? {
				command: process.execPath,
				args: [fixture, qa.socket, VERSION, "multi_session,extension_events", "answer"],
			},
		},
	});
}

async function startManagedFixture(
	qa: Qa,
	serverVersion: string,
	capabilities: string,
	behavior = "answer",
): Promise<{ pid: number; pidFile: { pid: number; processStartTime: string } }> {
	const child = spawn(process.execPath, [fixture, qa.socket, serverVersion, capabilities, behavior], {
		detached: true,
		stdio: "ignore",
	});
	children.push(child);
	if (child.pid === undefined) throw new Error("fixture did not spawn");
	const processStartTime = await waitForStartTime(child.pid, 2_000);
	await waitForProtocol(qa.socket);
	const paths = createHostDaemonPaths(qa.agentDir);
	await mkdir(paths.dir, { recursive: true });
	await writeFile(paths.pidFile, `${JSON.stringify({ pid: child.pid, processStartTime })}\n`, { mode: 0o600 });
	await writeFile(paths.settingsFile, `${JSON.stringify({ socket: qa.socket })}\n`, { mode: 0o600 });
	return { pid: child.pid, pidFile: { pid: child.pid, processStartTime } };
}

async function protocolInfo(socketPath: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		const timer = setTimeout(() => finish(new Error("protocol timeout")), 1_000);
		const finish = (error?: Error, value?: Record<string, unknown>) => {
			clearTimeout(timer);
			socket.destroy();
			error ? reject(error) : resolve(value!);
		};
		socket.once("connect", () => socket.write('{"id":"probe","type":"get_protocol_info"}\n'));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline !== -1) finish(undefined, JSON.parse(buffer.slice(0, newline)));
		});
		socket.once("error", finish);
	});
}

async function waitForProtocol(socketPath: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() <= deadline) {
		try {
			await protocolInfo(socketPath);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error("fixture protocol did not become ready");
}

async function expectGone(pidFile: { pid: number; processStartTime: string }): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() <= deadline) {
		if (!(await processMatchesPidFile(pidFile, readProcessStartTime))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`pid ${pidFile.pid} remained alive`);
}

async function stopManagedRoot(root: string): Promise<void> {
	try {
		const parsed = JSON.parse(await readFile(createHostDaemonPaths(join(root, "agent")).pidFile, "utf8"));
		if (
			typeof parsed?.pid === "number" &&
			typeof parsed?.processStartTime === "string" &&
			(await processMatchesPidFile(parsed, readProcessStartTime))
		) {
			process.kill(parsed.pid, "SIGKILL");
			await expectGone(parsed);
		}
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(child.pid, "SIGKILL");
	} catch {}
}
