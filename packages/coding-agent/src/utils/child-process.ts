import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

const EXIT_STDIO_GRACE_MS = 250;
const ABORT_EXIT_GRACE_MS = 5000;

export interface WaitForChildProcessOptions {
	/**
	 * Abort when the caller has killed the process and no longer needs its
	 * output. The wait then stops preserving stdio tails (descendants that
	 * survived the kill can no longer hold it open) and resolves as soon as
	 * the process exits, or after `abortExitGraceMs` if it never does.
	 */
	signal?: AbortSignal;
	/** Post-abort deadline for `exit` before resolving anyway. Default 5s. */
	abortExitGraceMs?: number;
}

export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a fixed deadline measured
 * from `exit`, or output still being written past that deadline is silently lost
 * (earendil-works/pi#5303). Instead, after `exit` we wait for the pipes to fall idle:
 * the grace timer is re-armed on every chunk, so an actively writing descendant keeps
 * us reading, while a quiet inherited handle (e.g. a Windows daemonized descendant
 * that never lets `close` fire) still releases us after the grace elapses.
 *
 * When `options.signal` aborts, the caller has killed the process and
 * abandoned its output: tail preservation ends, the pipes are destroyed, and
 * the wait resolves on `exit` — or after `abortExitGraceMs` when the kill
 * never lands (uninterruptible IO, failed taskkill).
 */
export function waitForChildProcess(child: ChildProcess, options?: WaitForChildProcessOptions): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let abortGraceTimer: NodeJS.Timeout | undefined;
		let detachAbortListener: (() => void) | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			if (abortGraceTimer) {
				clearTimeout(abortGraceTimer);
				abortGraceTimer = undefined;
			}
			if (detachAbortListener) {
				detachAbortListener();
				detachAbortListener = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			// Output is still arriving after exit; defer finalizing so we don't
			// destroy the stream mid-write and truncate the tail.
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				armIdleTimer();
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		const onAbortRelease = () => {
			// The caller killed the process and abandoned its output: destroy our
			// read ends so surviving descendants cannot re-arm the idle grace
			// forever, then wait only for `exit`, bounded by the abort grace.
			child.stdout?.destroy();
			child.stderr?.destroy();
			stdoutEnded = true;
			stderrEnded = true;
			if (exited) {
				maybeFinalizeAfterExit();
				return;
			}
			abortGraceTimer = setTimeout(() => finalize(exitCode), options?.abortExitGraceMs ?? ABORT_EXIT_GRACE_MS);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);

		const abortSignal = options?.signal;
		if (abortSignal) {
			if (abortSignal.aborted) {
				onAbortRelease();
			} else {
				abortSignal.addEventListener("abort", onAbortRelease, { once: true });
				detachAbortListener = () => abortSignal.removeEventListener("abort", onAbortRelease);
			}
		}
	});
}
