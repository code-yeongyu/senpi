import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { PipeFallbackSession, type PipeFallbackSessionExit } from "../src/pipe-fallback.ts";
import { SessionRegistry } from "../src/registry.ts";
import { TerminalSession } from "../src/session.ts";

// senpi#6201: the pipe fallback settles when its shell exits, while a process the command left running may still
// hold stdout. Settling must not cost the stop paths their reach: kill(), terminate() and registry teardown still
// signal the session's process group while it has members.

// Each wait is for one event and fails naming it; the bound is a circuit breaker for a real hang (#4024).
const EVENT_BOUND_MS = 30_000;
const BREAKER_MS = 3 * EVENT_BOUND_MS;
const LEAVES_SLEEP = "sleep 300 & echo grandchild=$!; exit 0";
const posixIt = it.skipIf(process.platform === "win32");

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

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

// Signals one exact pid (never a group); a process that already exited (ESRCH) needs nothing.
function killExactChild(pid: number): void {
	if (!(pid > 1)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function grandchildOf(output: () => string): number {
	return Number(/grandchild=(\d+)/.exec(output())?.[1]);
}

/** A pipe-fallback session whose shell exits at once and leaves `sleep 300` in its process group. */
async function settledWithLeftover(): Promise<{ session: TerminalSession; grandchild: number }> {
	const session = new TerminalSession(
		{ command: "sh", args: ["-c", LEAVES_SLEEP] },
		{ env: { SENPI_PTY_FORCE_PIPE: "1" } },
	);
	let buffered = "";
	session.onData((chunk) => {
		buffered += chunk.toString("utf8");
	});
	session.start();
	await within("the session settling after its shell exited", session.waitExit());
	return { session, grandchild: grandchildOf(() => buffered) };
}

describe("pipe fallback: a process the command left running (#6201)", () => {
	posixIt(
		"settles when the shell exits even while that process still holds the stdout pipe",
		async () => {
			const { session, grandchild } = await settledWithLeftover();
			try {
				expect(session.exitResult?.exitCode).toBe(0);
				expect(grandchild).toBeGreaterThan(1);
				// Settling neither waited for the leftover nor killed it.
				expect(isAlive(grandchild)).toBe(true);
			} finally {
				killExactChild(grandchild);
			}
		},
		BREAKER_MS,
	);

	posixIt(
		"terminate() after the settle still stops the leftover process",
		async () => {
			const { session, grandchild } = await settledWithLeftover();
			try {
				expect(isAlive(grandchild)).toBe(true);
				const exit = await session.terminate({ graceMs: 2000, forcedGraceMs: 2000 });
				expect(exit).toBe(session.exitResult);
				expect(isAlive(grandchild)).toBe(false);
			} finally {
				killExactChild(grandchild);
			}
		},
		BREAKER_MS,
	);

	posixIt(
		"kill() after the settle signals the leftover process group instead of answering 'already exited'",
		async () => {
			const { session, grandchild } = await settledWithLeftover();
			try {
				const result = session.kill("SIGTERM");
				expect(result.ok).toBe(true);
				expect(result.idempotent).toBeUndefined();
			} finally {
				await session.terminate({ graceMs: 2000, forcedGraceMs: 2000 });
				killExactChild(grandchild);
			}
		},
		BREAKER_MS,
	);

	posixIt(
		"registry teardown stops the leftover process of a session that already settled",
		async () => {
			const registry = new SessionRegistry<TerminalSession>({ stopExitGraceMs: 2000, forcedExitGraceMs: 2000 });
			const { session, grandchild } = await settledWithLeftover();
			try {
				await registry.create({ command: "sh", session });
				expect(isAlive(grandchild)).toBe(true);
				await registry.teardown();
				expect(isAlive(grandchild)).toBe(false);
			} finally {
				killExactChild(grandchild);
			}
		},
		BREAKER_MS,
	);

	posixIt(
		"kill() stays an idempotent 'already exited' once the process group is empty",
		async () => {
			const session = new TerminalSession(
				{ command: "sh", args: ["-c", "exit 0"] },
				{ env: { SENPI_PTY_FORCE_PIPE: "1" } },
			);
			session.start();
			await within("the session exiting", session.waitExit());
			expect(session.kill("SIGTERM")).toMatchObject({ ok: true, idempotent: true });
		},
		BREAKER_MS,
	);

	posixIt(
		"a 'close' that arrives after the drain timer settled the session changes nothing",
		async () => {
			const session = new PipeFallbackSession({
				command: "sh",
				args: ["-c", "sleep 300 & echo grandchild=$!; exit 5"],
			});
			let buffered = "";
			session.onData((chunk) => {
				buffered += chunk.toString("utf8");
			});
			const delivered: PipeFallbackSessionExit[] = [];
			session.onExit((exit) => delivered.push(exit));
			session.start();
			const child: unknown = Reflect.get(session, "child");
			if (!(child instanceof ChildProcess)) throw new Error("the pipe fallback session has no child process");
			const closed = once(child, "close");
			const grandchild = () => grandchildOf(() => buffered);
			try {
				const first = await within("the drain timer settling the session", session.waitExit());
				// The leftover still holds stdout, so this settle came from the drain timer and not from 'close'.
				expect(isAlive(grandchild())).toBe(true);
				killExactChild(grandchild());
				await within("'close' after the leftover exited", closed);
				const late = await new Promise<PipeFallbackSessionExit>((resolve) => session.onExit(resolve));
				expect(delivered).toHaveLength(1);
				expect(delivered[0]).toBe(first);
				expect(late).toBe(first);
				expect(first.exitCode).toBe(5);
			} finally {
				killExactChild(grandchild());
			}
		},
		BREAKER_MS,
	);
});
