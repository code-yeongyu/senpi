/** Event-driven fixture waits bounded by the CASE's own budget instead of a fixed wall-clock deadline. */
import type { ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";
import { beforeEach } from "vitest";

/**
 * vitest rejects a timed-out case with its own generic "Test timed out" error BEFORE the aborted
 * test signal reaches a wait, so a wait that wants to report the fixture's output must give up this
 * long before its case does (the bound taken from PR #4593's `exitWait`).
 */
export const REPORT_MARGIN_MS = 5_000;

/** Longest fixture output kept for a failure message; a boot failure says why in its last lines. */
const OUTPUT_TAIL_LIMIT = 4_000;

/**
 * `fs.watch` delivery is explicitly not guaranteed (node docs: events can be missing on some
 * platforms), and senpi#4629 measured exactly that: a loaded machine wrote the ready file - the
 * fixture's own stamps show it - while the directory watcher never reported it, so a watcher-only
 * wait hung until its deadline and blamed the fixture. The watch stays the fast path; this re-check
 * is the backstop that bounds a dropped event to one interval instead of the whole budget.
 */
const MISSED_EVENT_RECHECK_MS = 250;

/**
 * A per-case budget: `beforeEach` records when the case started, and the returned function answers
 * what is left of the budget that case was given, minus the margin the wait keeps for reporting.
 * Call it at describe level, exactly once per file.
 */
export function caseBudget(): (caseTimeoutMs: number) => number {
	let startedAt = Date.now();
	beforeEach(() => {
		startedAt = Date.now();
	});
	return (caseTimeoutMs: number) => Math.max(1_000, startedAt + caseTimeoutMs - REPORT_MARGIN_MS - Date.now());
}

export interface FixtureWait {
	/** What is left of the case's budget: `budget(CASE_TIMEOUT_MS)`, never a fixed number. */
	readonly timeoutMs: number;
	/** Everything the fixture has written so far; its tail is attached to every failure. */
	readonly output: () => string;
	/** Resolves once the fixture process is gone. A dead fixture can never become ready. */
	readonly gone?: Promise<unknown>;
}

export function outputTail(output: string): string {
	const trimmed = output.length > OUTPUT_TAIL_LIMIT ? output.slice(-OUTPUT_TAIL_LIMIT) : output;
	return trimmed.trim() === "" ? "<no fixture output>" : trimmed;
}

function failure(message: string, wait: FixtureWait): Error {
	return new Error(`${message}\n[fixture output]\n${outputTail(wait.output())}`);
}

/**
 * Waits for `path` to appear. The directory watcher is subscribed BEFORE this returns, so a file
 * written between the caller's trigger and the first check is still observed, and the wait ends at
 * the file's creation event, the fixture's death, or the case's remaining budget - whichever is
 * first. Subscribe before triggering the work that writes the file.
 */
export function waitForFixtureFile(path: string, wait: FixtureWait): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const settle = (error?: Error): void => {
			clearTimeout(timer);
			clearInterval(recheck);
			watcher.close();
			if (error) reject(error);
			else resolve();
		};
		const check = (): void => {
			if (existsSync(path)) settle();
		};
		const watcher = watch(dirname(path), check);
		const recheck = setInterval(check, MISSED_EVENT_RECHECK_MS);
		const timer = setTimeout(
			() => settle(failure(`${path} was not written within ${String(wait.timeoutMs)}ms`, wait)),
			wait.timeoutMs,
		);
		void wait.gone?.then(() => {
			// The exit can land before the write it preceded is visible; one last check decides.
			if (existsSync(path)) return settle();
			settle(failure(`${path} was never written: the fixture exited first`, wait));
		});
		check();
	});
}

/** Waits for `child` to exit within what is left of the case's budget, reporting its output. */
export function waitForFixtureExit(child: ChildProcess, wait: FixtureWait, label: string): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const settle = (error?: Error): void => {
			clearTimeout(timer);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolve();
		};
		const onExit = (): void => settle();
		const timer = setTimeout(
			() => settle(failure(`${label} did not exit within ${String(wait.timeoutMs)}ms`, wait)),
			wait.timeoutMs,
		);
		child.on("exit", onExit);
	});
}

/** Collects a spawned fixture's stderr while still forwarding it, so a failure can quote its tail. */
export function captureStderr(child: ChildProcess): () => string {
	const chunks: string[] = [];
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		chunks.push(chunk);
		process.stderr.write(chunk);
	});
	return () => chunks.join("");
}
