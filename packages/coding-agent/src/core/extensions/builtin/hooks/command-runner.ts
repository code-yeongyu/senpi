import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { waitForChildProcess } from "../../../../utils/child-process.ts";
import {
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../../../utils/shell.ts";
import type { ExecutableHookHandler, HookInputWire } from "./types.ts";

export type CommandHookRunOptions = {
	readonly cwd: string;
	readonly signal?: AbortSignal;
};

export type CommandHookRunResult = {
	readonly command: string;
	readonly cwd: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly durationMs: number;
	readonly timeoutSeconds?: number;
};

export async function runCommandHook(
	handler: ExecutableHookHandler,
	input: HookInputWire,
	options: CommandHookRunOptions,
): Promise<CommandHookRunResult> {
	const command = selectCommandForPlatform(handler);
	const startedAt = performance.now();
	if (options.signal?.aborted) {
		return buildResult({
			aborted: true,
			command,
			cwd: options.cwd,
			exitCode: null,
			signal: null,
			startedAt,
			stderr: "",
			stdout: "",
			timedOut: false,
			timeoutSeconds: handler.config.timeout,
		});
	}

	const child = spawn(command, {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: getShellEnv(),
		shell: true,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	if (child.pid !== undefined) trackDetachedChildPid(child.pid);

	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let exitSignal: NodeJS.Signals | null = null;
	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;

	const killChild = (): void => {
		if (child.pid !== undefined) killProcessTree(child.pid);
	};
	const onAbort = (): void => killChild();

	try {
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("exit", (_code, signal) => {
			exitSignal = signal;
		});

		const timeoutSeconds = handler.config.timeout;
		if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killChild();
			}, timeoutSeconds * 1000);
		}

		if (options.signal !== undefined) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdin?.end(JSON.stringify(input));
		const exitCode = await waitForChildProcess(child);
		return buildResult({
			aborted: options.signal?.aborted === true,
			command,
			cwd: options.cwd,
			exitCode: timedOut || options.signal?.aborted === true ? null : exitCode,
			signal: exitSignal,
			startedAt,
			stderr: Buffer.concat(stderr).toString("utf8"),
			stdout: Buffer.concat(stdout).toString("utf8"),
			timedOut,
			timeoutSeconds,
		});
	} finally {
		if (child.pid !== undefined) untrackDetachedChildPid(child.pid);
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		if (options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);
	}
}

export function selectCommandForPlatform(
	handler: ExecutableHookHandler,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "win32" && handler.config.commandWindows !== undefined) {
		return handler.config.commandWindows;
	}
	return handler.config.command;
}

function buildResult(input: {
	readonly command: string;
	readonly cwd: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly startedAt: number;
	readonly timeoutSeconds?: number;
}): CommandHookRunResult {
	return {
		aborted: input.aborted,
		command: input.command,
		cwd: input.cwd,
		durationMs: Math.max(0, performance.now() - input.startedAt),
		exitCode: input.exitCode,
		signal: input.signal,
		stderr: input.stderr,
		stdout: input.stdout,
		timedOut: input.timedOut,
		...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
	};
}
