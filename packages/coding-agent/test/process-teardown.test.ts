import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { teardownChildProcessesAndRoots } from "./helpers/process-teardown.ts";

// Every wait below is on an exact child event, subscribed before the action that
// triggers it. These bounds only turn a lost event into a named failure; they never
// decide success. The churners do 20,000+ directory operations whose cost is a
// filesystem property (seconds on Linux, over half a minute per phase on a loaded
// macOS APFS volume, #3437), so no wall-clock budget can be tight and still correct.
const EVENT_DEADLINE_MS = 120_000;
// Hang backstop for the synchronous rmSync calls, which no event deadline can bound.
const HANG_CEILING_MS = 600_000;

const spawned: ChildProcessWithoutNullStreams[] = [];
const scratch: string[] = [];

// A failed or timed-out test must not orphan a live writer: it keeps filling the temp
// directory forever after the worker exits (#3437 found several left by earlier runs).
afterEach(async () => {
	for (const child of spawned.splice(0)) {
		const exited = waitForExit(child);
		child.kill("SIGKILL");
		await exited;
	}
	for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
}, HANG_CEILING_MS);

function scratchPath(path: string): string {
	scratch.push(path);
	return path;
}

function spawnChurner(root: string, termMarker: string, exitsOnTerm = false): ChildProcessWithoutNullStreams {
	const script = `
		const fs = require("node:fs");
		const path = require("node:path");
		const root = process.argv[1];
		const termMarker = process.argv[2];
		const exitsOnTerm = process.argv[3] === "true";
		for (let i = 0; i < 20000; i++) {
			fs.mkdirSync(path.join(root, "initial-" + i));
		}
		let i = 0;
		let interval;
		// Install the SIGTERM handler BEFORE announcing readiness: the parent
		// sends SIGTERM as soon as it reads "ready", and a signal that lands in
		// the gap between the write and process.on() takes the default action,
		// so the child dies without ever writing "term-observed" (seen on a
		// loaded CI runner as 'child closed before writing "term-observed"').
		process.on("SIGTERM", () => {
			fs.writeFileSync(termMarker, "term-observed");
			fs.writeSync(1, "term-observed\\n");
			if (exitsOnTerm) {
				clearInterval(interval);
				process.exit(0);
			}
		});
		// fs.writeSync, not process.stdout.write: pipe writes are async on
		// macOS, and process.exit() right after an async write discards it, so
		// the acknowledgement the parent waits on would be lost under load.
		fs.writeSync(1, "ready\\n");
		interval = setInterval(() => {
			try {
				const dir = path.join(root, "live-" + i++);
				fs.mkdirSync(dir);
				fs.writeFileSync(path.join(dir, "entry"), "x");
			} catch {}
		}, 0);
	`;
	const child = spawn(process.execPath, ["-e", script, root, termMarker, String(exitsOnTerm)], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	spawned.push(child);
	return child;
}

// Waiters are created before their trigger and awaited later, so a test that fails in between
// abandons them; afterEach's SIGKILL then rejects them with nobody awaiting, which vitest
// reports as an unhandled rejection against a later test. Observing the rejection at creation
// keeps it handled while every awaiter still receives it.
function observed(waiter: Promise<void>): Promise<void> {
	waiter.catch(() => {});
	return waiter;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return observed(
		new Promise<void>((resolve, reject) => {
			const deadline = setTimeout(
				() => reject(new Error(`child did not exit within ${EVENT_DEADLINE_MS}ms`)),
				EVENT_DEADLINE_MS,
			);
			child.once("exit", () => {
				clearTimeout(deadline);
				resolve();
			});
		}),
	);
}

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
	return observed(
		new Promise<void>((resolve, reject) => {
			let output = "";
			let settled = false;
			const deadline = setTimeout(
				() => finish(new Error(`child did not write "${expected}" within ${EVENT_DEADLINE_MS}ms`)),
				EVENT_DEADLINE_MS,
			);
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				child.stdout.off("data", onData);
				child.off("close", onClose);
				child.off("error", onError);
				if (error) reject(error);
				else resolve();
			};
			const onData = (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes(expected)) finish();
			};
			// "close" (exit + stdio drained), not "exit": the graceful churner
			// writes its acknowledgement and exits in the same handler turn, and
			// the exit event can beat the final stdout chunk. Pipe semantics
			// guarantee pre-exit writes are readable before EOF, so close is the
			// deterministic point at which "never wrote it" is provable.
			const onClose = () =>
				finish(new Error(`child closed before writing "${expected}"; saw: ${JSON.stringify(output)}`));
			const onError = (error: Error) => finish(error);
			child.stdout.on("data", onData);
			child.once("close", onClose);
			child.once("error", onError);
		}),
	);
}

describe("process teardown", () => {
	it(
		"proves immediate removal races a live writer, while event-driven teardown is clean",
		async () => {
			const oldRoot = scratchPath(mkdtempSync(join(tmpdir(), "senpi-teardown-old-")));
			const oldMarker = scratchPath(join(tmpdir(), `senpi-teardown-old-marker-${process.pid}`));
			const oldChild = spawnChurner(oldRoot, oldMarker);
			await waitForOutput(oldChild, "ready");
			const oldTermObserved = waitForOutput(oldChild, "term-observed");
			oldChild.kill("SIGTERM");
			await oldTermObserved;
			let oldError: unknown;
			try {
				rmSync(oldRoot, { recursive: true, force: true });
			} catch (error) {
				oldError = error;
			}
			const oldExited = waitForExit(oldChild);
			oldChild.kill("SIGKILL");
			await oldExited;
			if (!oldError) rmSync(oldRoot, { recursive: true, force: true });
			expect(oldError).toMatchObject({ code: "ENOTEMPTY" });

			rmSync(oldMarker, { force: true });

			const newRoot = scratchPath(mkdtempSync(join(tmpdir(), "senpi-teardown-new-")));
			const newMarker = scratchPath(join(tmpdir(), `senpi-teardown-new-marker-${process.pid}`));
			const newChild = spawnChurner(newRoot, newMarker);
			await waitForOutput(newChild, "ready");
			// Subscribed before teardown sends SIGTERM, so the acknowledgement cannot be missed.
			const newTermObserved = waitForOutput(newChild, "term-observed");
			await teardownChildProcessesAndRoots(
				[newChild],
				[newRoot],
				100,
				// This churner acknowledges SIGTERM but never exits, so teardown
				// must escalate to SIGKILL; the acknowledgement wait guarantees the
				// marker is written before escalation can fire.
				() => newTermObserved,
			);
			expect(readFileSync(newMarker, "utf8")).toBe("term-observed");
			rmSync(newMarker, { force: true });
			expect(() => rmSync(newRoot, { recursive: true })).toThrow(/ENOENT/);
		},
		HANG_CEILING_MS,
	);

	it(
		"waits for a child that exits gracefully on SIGTERM",
		async () => {
			const root = scratchPath(mkdtempSync(join(tmpdir(), "senpi-teardown-graceful-")));
			const marker = scratchPath(join(tmpdir(), `senpi-teardown-graceful-marker-${process.pid}`));
			const child = spawnChurner(root, marker, true);
			await waitForOutput(child, "ready");
			const termObserved = waitForOutput(child, "term-observed");
			await teardownChildProcessesAndRoots(
				[child],
				[root],
				undefined,
				// Await the child's own acknowledgement that it handled SIGTERM
				// (it exits in the same handler turn), so the exit deadline can
				// never preempt the graceful path under load.
				() => termObserved,
			);
			expect(readFileSync(marker, "utf8")).toBe("term-observed");
			expect(child.exitCode).toBe(0);
			expect(child.signalCode).not.toBe("SIGKILL");
			rmSync(marker, { force: true });
			expect(() => rmSync(root, { recursive: true })).toThrow(/ENOENT/);
		},
		HANG_CEILING_MS,
	);
});
