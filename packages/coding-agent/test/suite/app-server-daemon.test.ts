import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseDaemonPidFile,
	processMatchesPidFile,
	readProcessStartTime,
	stopValidatedPid,
	waitForStartTime,
} from "../../src/modes/app-server/daemon/process.ts";
import { createDaemonPaths, withDaemonStateLock } from "../../src/modes/app-server/daemon.ts";
import { listenOnQaPort } from "../helpers/qa-port.ts";
import { closeServer, runDaemonCli, type StartedDaemon, startDaemonOnQaPort } from "./app-server-daemon-cli-harness.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("app-server daemon state", () => {
	it("rejects malformed pidfiles and detects start-time mismatches", async () => {
		// Given: malformed, valid, and stale app-server pidfile payloads.
		const malformed = parseDaemonPidFile("{");
		const valid = parseDaemonPidFile('{"pid":123,"processStartTime":"Mon Jul  2 10:00:00 2026"}');

		// When: the parsed records are compared with a process start-time reader.
		const matches = valid ? await processMatchesPidFile(valid, async () => "Mon Jul  2 10:00:00 2026") : false;
		const stale = valid ? await processMatchesPidFile(valid, async () => "Mon Jul  2 10:00:01 2026") : true;

		// Then: only the valid pidfile with the exact process start time is accepted.
		expect(malformed).toBeUndefined();
		expect(matches).toBe(true);
		expect(stale).toBe(false);
	});

	it("retries transient process identity errors while waiting for startup", async () => {
		vi.useFakeTimers();
		try {
			let attempts = 0;
			const result = waitForStartTime(42, 1_000, async () => {
				attempts++;
				if (attempts === 1) throw new Error("process identity temporarily unavailable");
				return "stable-process-identity";
			});
			await vi.advanceTimersByTimeAsync(20);
			await expect(result).resolves.toBe("stable-process-identity");
			expect(attempts).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads a stable identity for a live process and none for an exited process", async () => {
		const liveIdentity = await readProcessStartTime(process.pid);
		expect(liveIdentity).toBeTruthy();
		expect(await readProcessStartTime(process.pid)).toBe(liveIdentity);

		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		await withTimeout(once(child, "spawn"), 2_000, "identity probe child did not spawn");
		if (child.pid === undefined) throw new Error("expected identity probe child pid");
		const childPid = child.pid;
		child.kill();
		await withTimeout(once(child, "exit"), 2_000, "identity probe child did not exit");
		expect(await readProcessStartTime(childPid)).toBeUndefined();
	});

	it("serializes daemon commands with the state lock", async () => {
		// Given: two daemon operations sharing one state directory.
		const root = await scratchRoot("senpi-daemon-lock-");
		const paths = createDaemonPaths(join(root, "agent"));
		const events: string[] = [];
		const firstEntered = createDeferred<void>();
		const releaseFirst = createDeferred<void>();
		const first = withDaemonStateLock(paths, async () => {
			events.push("first-enter");
			firstEntered.resolve(undefined);
			await releaseFirst.promise;
			events.push("first-exit");
			return "first";
		});
		await withTimeout(firstEntered.promise, 2_000, "first daemon lock operation did not enter");

		// When: a second operation starts before the first releases the lock.
		const second = withDaemonStateLock(paths, async () => {
			events.push("second-enter");
			return "second";
		});
		releaseFirst.resolve();
		const results = await Promise.all([first, second]);

		// Then: the second operation enters only after the first exits.
		expect(results).toEqual(["first", "second"]);
		expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
	});

	it("does not recreate state directories after signaling a validated pid", async () => {
		// Given: a validated daemon pid and a removed state directory.
		const root = await scratchRoot("senpi-daemon-stop-");
		const stateDir = join(root, "agent", "app-server-daemon");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		await withTimeout(once(child, "spawn"), 2_000, "child process did not spawn");
		if (child.pid === undefined) throw new Error("expected child pid");
		// The fixture child is live, so its identity must resolve; waitForStartTime returns undefined
		// only when the probe is starved on a loaded host, which this fixture does not exercise.
		const processStartTime = await waitForStartTime(child.pid, 5_000);
		if (processStartTime === undefined) throw new Error("fixture child had no process identity");
		const pidFile = { pid: child.pid, processStartTime };
		await rm(stateDir, { recursive: true, force: true });

		try {
			// When: the validated pid is stopped through the process helper.
			await stopValidatedPid(pidFile, "SIGTERM");

			// Then: the helper only signals the process and leaves directory ownership to the caller.
			await expect(access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await processMatchesPidFile(pidFile)).toBe(false);
		} finally {
			if (await processMatchesPidFile(pidFile)) child.kill("SIGKILL");
		}
	}, 15_000);
});

describe("app-server daemon CLI", () => {
	it("starts, reports status, attaches idempotently, and stops a managed daemon", async () => {
		// Given: a scratch agent directory and a non-default loopback port.
		const root = await scratchRoot("senpi-daemon-cli-");
		const agentDir = join(root, "agent");
		const startedDaemon = await startDaemonAfterAddressInUse(agentDir);
		const { listen, port, started } = startedDaemon;

		try {
			// When: daemon commands are driven through the real CLI surface.
			const pidFile = parseDaemonPidFile(
				await readFile(join(agentDir, "app-server-daemon", "app-server.pid"), "utf8"),
			);
			const settings = JSON.parse(await readFile(join(agentDir, "app-server-daemon", "settings.json"), "utf8"));
			const pidMatches = pidFile ? await processMatchesPidFile(pidFile, readProcessStartTime) : false;
			const status = await runDaemonCli(agentDir, ["status"]);
			const attached = await runDaemonCli(agentDir, ["start", "--listen", listen]);
			const stopped = await runDaemonCli(agentDir, ["stop"]);
			const stoppedStatus = await runDaemonCli(agentDir, ["status"]);

			// Then: each command emits one JSON object and the pidfile records the listener process start time.
			expect(started.json).toMatchObject({ status: "started", listen });
			expect(typeof started.json.pid).toBe("number");
			expect(pidFile?.pid).toBe(started.json.pid);
			expect(pidMatches).toBe(true);
			expect(settings).toEqual({ listen: { kind: "ws", url: listen, host: "127.0.0.1", port }, extensions: [] });
			expect(status.json).toMatchObject({ status: "running", pid: started.json.pid, listen });
			expect(attached.json).toMatchObject({ status: "already-running", pid: started.json.pid, listen });
			expect(stopped.json).toEqual({ status: "stopped" });
			expect(stoppedStatus.json).toEqual({ status: "not-running" });
		} finally {
			await runDaemonCli(agentDir, ["stop"]).catch(() => undefined);
		}
	}, 180_000);
});

function createDeferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((resolveDeferred) => {
		resolvePromise = resolveDeferred;
	});
	return { promise, resolve: resolvePromise };
}

async function scratchRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function startDaemonAfterAddressInUse(agentDir: string): Promise<StartedDaemon> {
	const blocker = createServer((socket) => socket.destroy());
	const blockedPort = await listenOnQaPort(blocker, 18999);
	const blockedListen = `ws://127.0.0.1:${blockedPort}`;
	try {
		await expect(runDaemonCli(agentDir, ["start", "--listen", blockedListen])).rejects.toThrow(
			`EADDRINUSE: app-server daemon cannot listen on ${blockedListen}`,
		);
		await expect(access(join(agentDir, "app-server-daemon", "stderr.log"))).rejects.toMatchObject({ code: "ENOENT" });
		const started = await startDaemonOnQaPort(agentDir, blockedPort);
		expect(started.port).not.toBe(blockedPort);
		return started;
	} finally {
		await closeServer(blocker);
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise((resolveResult, rejectResult) => {
		const timeout = setTimeout(() => rejectResult(new Error(message)), timeoutMs);
		void promise.then(
			(value) => {
				clearTimeout(timeout);
				resolveResult(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				rejectResult(error);
			},
		);
	});
}
