import { type ChildProcess, spawn } from "node:child_process";
import { signalSpawnedChild } from "../../../../utils/child-signal.ts";
import { buildClaudeCliEnvironment } from "./claude-cli-environment.ts";

/** One `claude auth *` invocation for a CLI-store account. */
export type ClaudeCliRun = {
	/** The executable the turn path resolves, so sign-in and turns use the same binary. */
	readonly executable: string;
	readonly configDir: string;
	readonly parentEnv?: NodeJS.ProcessEnv;
};

export function spawnClaudeCli(run: ClaudeCliRun, args: readonly string[], browser?: string): ChildProcess {
	return spawn(run.executable, [...args], {
		cwd: run.configDir,
		env: buildClaudeCliEnvironment(run.parentEnv ?? process.env, {
			configDir: run.configDir,
			...(browser === undefined ? {} : { browser }),
		}),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
}

/** SIGTERM now, SIGKILL after `graceMs` if the child is still running. */
export function stopClaudeCli(child: ChildProcess, graceMs: number): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	signalSpawnedChild(child, "SIGTERM");
	const escalate = setTimeout(() => signalSpawnedChild(child, "SIGKILL"), graceMs);
	escalate.unref?.();
	child.once("close", () => clearTimeout(escalate));
}

export type ClaudeCliExit = { readonly exitCode: number | null; readonly stdout: string };

const DEFAULT_SHORT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Runs a short command (`auth status`, `auth logout`) to exit, killing it at the deadline or when `signal` aborts
 * (both answer `undefined`). Never logs its output.
 */
export function runClaudeCliToExit(
	run: ClaudeCliRun,
	args: readonly string[],
	timeoutMs: number = DEFAULT_SHORT_COMMAND_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<ClaudeCliExit | undefined> {
	if (signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const child = spawnClaudeCli(run, args);
		child.stdin?.end();
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.resume();
		const deadline = setTimeout(() => {
			signalSpawnedChild(child, "SIGKILL");
			resolve(undefined);
		}, timeoutMs);
		deadline.unref?.();
		const onAbort = (): void => {
			clearTimeout(deadline);
			signalSpawnedChild(child, "SIGKILL");
			resolve(undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", () => {
			clearTimeout(deadline);
			signal?.removeEventListener("abort", onAbort);
			resolve(undefined);
		});
		child.once("close", (exitCode: number | null) => {
			clearTimeout(deadline);
			signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode, stdout });
		});
	});
}
