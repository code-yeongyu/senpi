import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

let directory: string | undefined;
let executable: string | undefined;

afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

export interface ProcessExitEvent {
	wait(timeoutMs: number, command: string): Promise<void>;
	dispose(): Promise<void>;
}

/** Arm NOTE_EXIT/pidfd before triggering shutdown; Node cannot emit 'exit' for a non-child. */
export async function processExitEvent(pid: number): Promise<ProcessExitEvent> {
	if (!executable) {
		const outputDirectory = mkdtempSync(join(tmpdir(), "senpi-exit-event-"));
		const outputExecutable = join(outputDirectory, "wait-process-exit");
		try {
			execFileSync("cc", [
				"-Wall",
				"-Wextra",
				"-Werror",
				join(import.meta.dirname, "../fixtures/wait-process-exit.c"),
				"-o",
				outputExecutable,
			]);
		} catch (cause) {
			rmSync(outputDirectory, { recursive: true, force: true });
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
				throw new Error("Missing C compiler 'cc' on PATH: required for POSIX process-exit tests", { cause });
			throw cause;
		}
		directory = outputDirectory;
		executable = outputExecutable;
	}
	const waiter = spawn(executable, [String(pid)], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	waiter.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<void>((resolve, reject) => {
		waiter.once("error", reject);
		waiter.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`exit waiter for pid ${pid}: ${code ?? signal}: ${stderr}`));
		});
	});
	// A long-lived observation can reject before its assertion starts awaiting it.
	void exited.catch(() => {});
	try {
		await withBound(
			new Promise<void>((resolve, reject) => {
				let output = "";
				waiter.stdout.on("data", (chunk) => {
					output += chunk.toString();
					if (output.includes("ready\n")) resolve();
				});
				// ESRCH, or an exit immediately after registration, also establishes the observed end.
				void exited.then(resolve, reject);
			}),
			10_000,
			`arming exit event for pid ${pid}`,
		);
	} catch (cause) {
		if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill("SIGTERM");
		await exited.catch(() => {});
		throw cause;
	}
	return {
		wait: (timeoutMs, command) => withBound(exited, timeoutMs, `pid ${pid} (${command}) exit unobserved`),
		dispose: async () => {
			if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill("SIGTERM");
			await exited.catch(() => {});
		},
	};
}

async function withBound(operation: Promise<void>, timeoutMs: number, label: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
