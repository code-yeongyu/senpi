import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { NativePtyLoadResult } from "../src/native-loader.ts";
import {
	createPipeFallbackSession,
	isPipeFallbackForced,
	PipeFallbackSession,
	shouldUsePipeFallback,
	terminateChildTree,
} from "../src/pipe-fallback.ts";

function nodeSession(script: string, options: { timeoutMs?: number } = {}): PipeFallbackSession {
	const session = new PipeFallbackSession({
		command: process.execPath,
		args: ["-e", script],
		timeoutMs: options.timeoutMs,
	});
	session.start();
	return session;
}

async function collectOutput(session: PipeFallbackSession): Promise<{ output: string; exitCode: number | null }> {
	const chunks: Buffer[] = [];
	session.onData((chunk) => chunks.push(chunk));
	const exit = await session.waitExit();
	return { output: Buffer.concat(chunks).toString("utf8"), exitCode: exit.exitCode };
}

describe("PipeFallbackSession", () => {
	it("runs a command through child_process pipes, streams output, and reports the exit code", async () => {
		const session = nodeSession(`
			setTimeout(() => {
				process.stdout.write("stdout-ok\\n");
				process.stderr.write("stderr-ok\\n");
				process.exit(7);
			}, 10);
		`);

		const result = await collectOutput(session);

		expect(result.output).toContain("stdout-ok");
		expect(result.output).toContain("stderr-ok");
		expect(result.exitCode).toBe(7);
	});

	it("selects pipe fallback when SENPI_PTY_FORCE_PIPE=1 even if native is available", async () => {
		const nativeLoadResult: NativePtyLoadResult = { native: { PtySession: class PtySession {} }, diagnostic: null };

		expect(isPipeFallbackForced({ SENPI_PTY_FORCE_PIPE: "1" })).toBe(true);
		expect(shouldUsePipeFallback(nativeLoadResult, { SENPI_PTY_FORCE_PIPE: "1" })).toBe(true);

		const previous = process.env.SENPI_PTY_FORCE_PIPE;
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		try {
			const session = createPipeFallbackSession({
				command: process.execPath,
				args: ["-e", "process.stdout.write('forced-pipe')"],
			});
			const result = await collectOutput(session);
			expect(result.output).toBe("forced-pipe");
			expect(session.note).toContain("pipe fallback");
		} finally {
			if (previous === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
			else process.env.SENPI_PTY_FORCE_PIPE = previous;
		}
	});

	it("reports resize as a clear not-PTY no-op while the session survives", async () => {
		const session = nodeSession(`
			setTimeout(() => {
				process.stdout.write("after-resize");
				process.exit(0);
			}, 25);
		`);

		const resize = session.resize(132, 43);
		const result = await collectOutput(session);

		expect(resize.ok).toBe(false);
		expect(resize.note).toContain("not a PTY");
		expect(result.output).toBe("after-resize");
		expect(result.exitCode).toBe(0);
	});

	it("writes to a live stdin pipe and rejects writes after exit with an informative note", async () => {
		const session = nodeSession(`
			process.stdin.once("data", (chunk) => {
				process.stdout.write("input:" + chunk.toString("utf8"));
				process.exit(0);
			});
		`);
		const chunks: Buffer[] = [];
		session.onData((chunk) => chunks.push(chunk));

		const write = session.write("hello\n");
		const exit = await session.waitExit();
		const afterExitWrite = session.write("late");

		expect(write.ok).toBe(true);
		expect(Buffer.concat(chunks).toString("utf8")).toBe("input:hello\n");
		expect(exit.exitCode).toBe(0);
		expect(afterExitWrite.ok).toBe(false);
		expect(afterExitWrite.note).toContain("exited");
	});

	it("surfaces malformed command spawn failures without pretending output success", async () => {
		const session = new PipeFallbackSession({
			command: "definitely-not-a-senpi-command",
			args: ["--version"],
		});
		session.start();

		const exit = await session.waitExit();

		expect(exit.exitCode).toBeNull();
		expect(exit.error?.code).toBe("spawn_error");
		expect(exit.error?.message).toContain("definitely-not-a-senpi-command");
	});

	it("does not allow stale exited sessions to be restarted", async () => {
		const session = nodeSession("process.exit(0)");
		await session.waitExit();

		expect(() => session.start()).toThrow(/Cannot restart exited pipe fallback session/);
	});

	it("preserves a non-zero exit code even when output claims success", async () => {
		const session = nodeSession("process.stdout.write('SUCCESS\\n'); process.exit(3)");
		const result = await collectOutput(session);

		expect(result.output).toContain("SUCCESS");
		expect(result.exitCode).toBe(3);
	});

	it("times out a hung command when timeoutMs is supplied", async () => {
		const session = nodeSession("setInterval(() => {}, 1000)", { timeoutMs: 30 });

		const exit = await session.waitExit();

		expect(exit.timedOut).toBe(true);
		expect(exit.exitCode).toBeNull();
		await delay(5);
		expect(session.write("late").ok).toBe(false);
	});
});

// Each wait is for one event and fails naming it. The bound is a circuit breaker for a real hang, never the expected
// duration: on a loaded CI runner a process start can take seconds (#4024).
const EVENT_BOUND_MS = 30_000;
const DETACHMENT_BREAKER_MS = 3 * EVENT_BOUND_MS;

async function within<T>(event: string, pending: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const breaker = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${event} did not happen within ${EVENT_BOUND_MS} ms`)),
			EVENT_BOUND_MS,
		);
	});
	try {
		return await Promise.race([pending, breaker]);
	} finally {
		clearTimeout(timer);
	}
}

// Signals one exact pid (never a group); a child that already exited (ESRCH) needs nothing.
function killExactChild(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

describe("PipeFallbackSession terminal detachment", () => {
	const posixIt = it.skipIf(process.platform === "win32");

	posixIt(
		"runs the child in its own process group so it cannot read senpi's controlling terminal",
		async () => {
			// A child sharing senpi's session keeps the user's terminal as its
			// controlling tty, so a sudo-style /dev/tty read races the TUI's raw
			// stdin reader and corrupts both inputs. Detached children lead their
			// own session: pgid equals the child pid. The parent checks that directly
			// (a group whose id is the child pid exists) instead of spawning `ps` from
			// the child, which added a third process start inside a fixed 5 s budget
			// and timed out on a loaded runner (#4024).
			const session = new PipeFallbackSession({
				command: process.execPath,
				args: ["-e", 'process.stdout.write("READY\\n"); process.stdin.resume();'],
			});
			const ready = new Promise<void>((resolve) => {
				let buffered = "";
				session.onData((chunk) => {
					buffered += chunk.toString("utf8");
					if (buffered.includes("READY")) resolve();
				});
			});
			let settled = false;
			const exited = session.waitExit().then((exit) => {
				settled = true;
				return exit;
			});
			session.start();

			try {
				await within("the child printing READY", ready);
				const pid = session.pid;
				expect(pid).toBeGreaterThan(1);
				// Signal 0 delivers nothing; it only fails (ESRCH) when no process group has this id.
				expect(() => process.kill(-(pid as number), 0)).not.toThrow();

				expect(session.kill("SIGTERM").ok).toBe(true);
				const exit = await within("the child exiting after SIGTERM", exited);
				expect(exit.signal).toBe("SIGTERM");
			} finally {
				// A failed assertion above must not leave the detached child running past the test. Cleanup signals only
				// that exact child pid, never a process group, and never a pid <= 1.
				const pid = session.pid;
				if (!settled && pid !== undefined && pid > 1) {
					killExactChild(pid);
					await within("the child exiting after cleanup", exited);
				}
			}
		},
		DETACHMENT_BREAKER_MS,
	);

	posixIt(
		"kill() terminates grandchildren so waitExit settles even when they hold the stdout pipe",
		async () => {
			// Without a group kill, SIGTERM reaches only the direct shell; the
			// backgrounded grandchild keeps the stdout pipe open and 'close'
			// never fires (the POSIX twin of the Windows taskkill /T branch).
			const session = new PipeFallbackSession({
				command: "sh",
				args: ["-c", "sleep 300 & echo READY; wait"],
			});
			session.start();

			await new Promise<void>((resolve) => {
				let buffered = "";
				session.onData((chunk) => {
					buffered += chunk.toString("utf8");
					if (buffered.includes("READY")) resolve();
				});
			});

			const kill = session.kill("SIGTERM");
			expect(kill.ok).toBe(true);

			const exit = await session.waitExit();
			expect(exit.signal).toBe("SIGTERM");
			expect(exit.exitCode).toBeNull();
		},
		5000,
	);
});

describe("PipeFallbackSession Windows process-tree cleanup", () => {
	it("does not crash when taskkill is unavailable during kill", () => {
		const moduleUrl = new URL("../src/pipe-fallback.ts", import.meta.url).href;
		const script = `
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			process.env.PATH = "";
			const { PipeFallbackSession } = await import(${JSON.stringify(moduleUrl)});
			const session = new PipeFallbackSession({
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
			}).start();
			const timeout = setTimeout(() => {
				process.stderr.write("PIPE_FALLBACK_KILL_TIMEOUT\\n");
				process.exit(2);
			}, 2000);
			session.kill("SIGTERM");
			await session.waitExit();
			clearTimeout(timeout);
			process.stdout.write("DIRECT_FALLBACK_SETTLED\\n");
		`;

		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
			encoding: "utf8",
			timeout: 5000,
		});

		expect({
			signal: result.signal,
			status: result.status,
			stderr: result.stderr,
			stdout: result.stdout,
		}).toEqual({
			signal: null,
			status: 0,
			stderr: "",
			stdout: "DIRECT_FALLBACK_SETTLED\n",
		});
	});
});

describe("terminateChildTree", () => {
	it("never signals a child that never started", () => {
		// senpi#3706: on Node < 24.22 / 26.10, kill() on a child without a pid signals the caller's own process group.
		const signals: NodeJS.Signals[] = [];
		const child = {
			pid: undefined,
			kill: (signal?: NodeJS.Signals) => {
				signals.push(signal ?? "SIGTERM");
				return true;
			},
		};

		expect(terminateChildTree(child, "SIGTERM")).toBe("none");
		expect(signals).toEqual([]);
	});

	it("falls back to a direct kill when no process-group signal is available", () => {
		// The branch Windows always takes (and POSIX takes once the group is
		// gone). Every stop path routes through here, so losing the fallback
		// would leave timed-out children running forever.
		const signals: NodeJS.Signals[] = [];
		const child = {
			// A pid above every platform's pid_max, so the group signal fails with ESRCH.
			pid: 2 ** 22 + 1,
			kill: (signal?: NodeJS.Signals) => {
				signals.push(signal ?? "SIGTERM");
				return true;
			},
		};

		const route = terminateChildTree(child, "SIGTERM");

		expect(route).toBe("direct");
		expect(signals).toEqual(["SIGTERM"]);
	});
});
