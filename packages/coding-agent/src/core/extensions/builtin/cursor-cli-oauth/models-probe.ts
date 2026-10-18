import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { cursorAgentEnvironment } from "./environment.ts";

export type CursorCliModelProbeInput = {
	readonly executable: string;
	readonly stdoutPath: string;
	readonly timeoutMs: number;
	readonly home: string;
};

export type CursorCliModelProbe = (input: CursorCliModelProbeInput) => Promise<void>;

export class CursorCliModelProbeTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`cursor-agent models exceeded its ${timeoutMs}ms deadline`);
		this.name = "CursorCliModelProbeTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export class CursorCliModelProbeExitError extends Error {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;

	constructor(exitCode: number | null, signal: NodeJS.Signals | null) {
		super(`cursor-agent models failed with code ${String(exitCode)} and signal ${String(signal)}`);
		this.name = "CursorCliModelProbeExitError";
		this.exitCode = exitCode;
		this.signal = signal;
	}
}

export const runModelsProbe: CursorCliModelProbe = async ({ executable, stdoutPath, timeoutMs, home }) => {
	const output = await open(stdoutPath, "w");
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(executable, ["models"], {
				env: cursorAgentEnvironment(home),
				stdio: ["ignore", output.fd, "ignore"],
			});
			let timedOut = false;
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				if (error) reject(error);
				else resolve();
			};
			const deadline = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);
			child.once("error", (error) => finish(error));
			child.once("close", (code, signal) => {
				if (timedOut) {
					finish(new CursorCliModelProbeTimeoutError(timeoutMs));
					return;
				}
				if (code !== 0) {
					finish(new CursorCliModelProbeExitError(code, signal));
					return;
				}
				finish();
			});
		});
	} finally {
		await output.close();
	}
};
