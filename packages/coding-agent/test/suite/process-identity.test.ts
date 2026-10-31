import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseDaemonPidFile,
	processMatchesPidFile,
	readProcessStartTime,
	stopValidatedPid,
	waitForStartTime,
} from "../../src/utils/process-identity.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

// #3167: process ownership is shared by Native RPC and terminal lifecycle.
describe("process identity", () => {
	it("rejects malformed pidfiles and detects start-time mismatches", async () => {
		// Given: malformed, valid, and stale pidfile payloads.
		const malformed = parseDaemonPidFile("{");
		const valid = parseDaemonPidFile('{"pid":123,"processStartTime":"Mon Jul  2 10:00:00 2026"}');

		// When: the parsed records are compared with a process start-time reader.
		const matches = valid ? await processMatchesPidFile(valid, async () => "Mon Jul  2 10:00:00 2026") : false;
		const stale = valid ? await processMatchesPidFile(valid, async () => "Mon Jul  2 10:00:04 2026") : true;

		// Then: the valid pidfile matches, and a start beyond the shared tolerance does not.
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
		try {
			await once(child, "spawn", { signal: AbortSignal.timeout(2_000) });
			if (child.pid === undefined) throw new Error("expected identity probe child pid");
			const exited = once(child, "exit", { signal: AbortSignal.timeout(2_000) });
			child.kill();
			await exited;
			expect(await readProcessStartTime(child.pid)).toBeUndefined();
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit", { signal: AbortSignal.timeout(2_000) });
				child.kill("SIGKILL");
				await exited;
			}
		}
	});

	it("does not recreate state directories after signaling a validated pid", async () => {
		// Given: a validated pid and a removed state directory.
		const root = await mkdtemp(join(tmpdir(), "senpi-process-stop-"));
		roots.push(root);
		const stateDir = join(root, "runtime-state");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		try {
			await once(child, "spawn", { signal: AbortSignal.timeout(2_000) });
			if (child.pid === undefined) throw new Error("expected child pid");
			const processStartTime = await waitForStartTime(child.pid, 5_000);
			if (processStartTime === undefined) throw new Error("fixture child had no process identity");
			const pidFile = { pid: child.pid, processStartTime };
			await rm(stateDir, { recursive: true, force: true });

			// When: the validated pid is stopped through the process helper.
			await stopValidatedPid(pidFile, "SIGTERM");

			// Then: directory ownership remains with the caller.
			await expect(access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await processMatchesPidFile(pidFile)).toBe(false);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit", { signal: AbortSignal.timeout(2_000) });
				child.kill("SIGKILL");
				await exited;
			}
		}
	}, 15_000);
});
