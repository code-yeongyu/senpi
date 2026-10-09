import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

export type ChildResult = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly pid: number;
};

export type ChildStage = "spawn" | "result" | "exit";

export const CHILD_HANG_WATCHDOG_MS = 240_000;
/**
 * Vitest deadline for a test that only awaits probed children: none. The probe's hang watchdog is the one deadline,
 * so a slow host only slows the test, and a vitest deadline can never race the watchdog and hide the stalled stage.
 */
export const CHILD_PROBE_TEST_TIMEOUT_MS = 0;

export class ChildHangError extends Error {
	readonly name = "ChildHangError";
	readonly stage: ChildStage;

	constructor(stage: ChildStage, stdout: string, stderr: string) {
		super(
			`Child probe hung in stage "${stage}": no progress for ${CHILD_HANG_WATCHDOG_MS} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
		this.stage = stage;
	}
}

export interface WatchedChild {
	readonly closed: Promise<ChildResult>;
	resultLine(): Promise<string>;
	dispose(): void;
}

export async function waitForChildReady(child: ChildProcess): Promise<void> {
	await Promise.race([
		once(child, "message"),
		once(child, "close").then(() => {
			throw new TypeError("Child probe closed before its ready marker");
		}),
	]);
}

/**
 * Follows a child through its stages. The hang watchdog is re-armed by every observable step (spawn, output, the
 * result line), so it fails only a child that stopped making progress, never a child on a slow host.
 */
export function watchChild(child: ChildProcess, options: { readonly resultLine?: boolean } = {}): WatchedChild {
	let stage: ChildStage = "spawn";
	let stdout = "";
	let stderr = "";
	let line: string | undefined;
	let settled = false;
	const lineWaiters: Array<{ resolve: (line: string) => void; reject: (error: unknown) => void }> = [];
	let watchdog: NodeJS.Timeout | undefined;
	let rejectClosed: (error: unknown) => void = () => {};

	const failLine = (error: unknown): void => {
		for (const waiter of lineWaiters.splice(0)) waiter.reject(error);
	};
	const fail = (error: unknown): void => {
		if (settled) return;
		settled = true;
		clearTimeout(watchdog);
		failLine(error);
		rejectClosed(error);
	};
	const arm = (): void => {
		clearTimeout(watchdog);
		if (settled) return;
		watchdog = setTimeout(() => {
			child.kill("SIGKILL");
			fail(new ChildHangError(stage, stdout, stderr));
		}, CHILD_HANG_WATCHDOG_MS);
	};

	const captureLine = options.resultLine === true;
	const closed = new Promise<ChildResult>((resolve, reject) => {
		rejectClosed = reject;
		child.once("spawn", () => {
			stage = options.resultLine === true ? "result" : "exit";
			arm();
		});
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (captureLine && line === undefined) {
				const newline = stdout.indexOf("\n");
				if (newline !== -1) {
					line = stdout.slice(0, newline).replace(/\r$/u, "");
					stage = "exit";
					for (const waiter of lineWaiters.splice(0)) waiter.resolve(line);
				}
			}
			arm();
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
			arm();
		});
		child.once("error", fail);
		child.once("close", (code, signal) => {
			if (settled) return;
			const pid = child.pid;
			if (pid === undefined) {
				fail(new TypeError("Child probe closed without spawning"));
				return;
			}
			settled = true;
			clearTimeout(watchdog);
			failLine(
				new TypeError(
					`Child probe closed before its result line (code ${code}, signal ${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
			resolve({ code, signal, stdout, stderr, pid });
		});
		arm();
	});
	// Callers that wait on the result line still see a hang through it; this only keeps `closed` from going unhandled.
	closed.catch(() => {});

	return {
		closed,
		resultLine: () =>
			new Promise<string>((resolve, reject) => {
				if (line !== undefined) resolve(line);
				else if (settled)
					closed.then(() => reject(new TypeError("Child probe closed before its result line")), reject);
				else lineWaiters.push({ resolve, reject });
			}),
		dispose: () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		},
	};
}

/** Close drains both pipes; the watchdog guards a hang, never child startup speed. */
export function collectChild(child: ChildProcess): Promise<ChildResult> {
	return watchChild(child).closed;
}

export interface ChildInput {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
}

export function startChild(input: ChildInput, options: { readonly resultLine?: boolean } = {}): WatchedChild {
	return watchChild(
		spawn(input.command, [...input.args], {
			cwd: input.cwd,
			env: input.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		}),
		options,
	);
}

export function runChild(input: ChildInput): Promise<ChildResult> {
	return startChild(input).closed;
}
