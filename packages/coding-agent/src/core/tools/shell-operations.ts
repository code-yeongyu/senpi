import type { ExecShell } from "@code-yeongyu/senpi-machine-ops";
import { posixSignalTable } from "./posix-signals.ts";
import type { ToolMachine } from "./tool-machine.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer, stream?: "stdout" | "stderr") => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			redactSecretsInOutput?: boolean;
			/** The session the command runs for; a local host attests the spawned shell to it (senpi#6972). */
			sessionId?: string;
		},
	) => Promise<{ exitCode: number | null }>;
}

/** What a shell run needs from the host it runs for: the shell, the cwd check, the environment and pid tracking. */
export interface ShellExecHost {
	/** The shell the command runs in; undefined lets the machine choose (`/bin/sh -c` on POSIX). */
	resolveShell(): ExecShell | undefined;
	/** Rejects when `cwd` does not exist where the command runs. */
	checkCwd(cwd: string, signal: AbortSignal | undefined): Promise<void>;
	/** "exact" runs with the tool's environment alone; "overlay" lays it over the machine's curated base. */
	readonly envMode: "exact" | "overlay";
	/** The environment when the caller passes none. */
	defaultEnv(): NodeJS.ProcessEnv | undefined;
	/** The number of a terminating signal, for the 128 + n exit code. */
	signalNumber(signal: string): number | undefined;
	onSpawn?(pid: number): void;
	onExit?(pid: number): void;
	/** Attests a shell this process spawned to the calling session; absent where the shell is not our child. */
	attestSessionSpawn?(sessionId: string, pid: number): { release(): unknown };
	/** Runs once the exec settles, success or not. */
	afterExec?(): void;
}

/**
 * A host that knows only the tool machine: the machine's shell and environment, the cwd checked there, and the signal
 * numbers of the machine's own OS.
 */
export function machineShellExecHost(machine: ToolMachine, shell?: ExecShell): ShellExecHost {
	return {
		resolveShell: () => shell,
		checkCwd: async (cwd, signal) => {
			await machine.ops.files.stat({ path: cwd }, machine.context(signal));
		},
		envMode: "overlay",
		defaultEnv: () => undefined,
		signalNumber: (signal) => posixSignalTable(machine.ops.info.host().os)[signal],
	};
}

/**
 * Shell execution used by the built-in shell tools: one `process.exec` of the operation layer (own process group,
 * abort/timeout kill the group). The tool keeps its own output handling.
 */
export function createShellOperations(shellName: string, machine: ToolMachine, host: ShellExecHost): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env, sessionId }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shell = host.resolveShell();
			try {
				await host.checkCwd(cwd, signal);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			let streamCallbackError: unknown;
			let hasStreamCallbackError = false;
			// A failing output callback stops the command the same way an abort does.
			const callbackAbort = new AbortController();
			const failStream = (error: unknown) => {
				if (hasStreamCallbackError) return;
				streamCallbackError = error;
				hasStreamCallbackError = true;
				callbackAbort.abort();
			};
			const handleData = (data: Buffer, stream: "stdout" | "stderr") => {
				if (hasStreamCallbackError) return;
				try {
					const callbackResult = (onData as (data: Buffer, stream: "stdout" | "stderr") => unknown)(data, stream);
					if (callbackResult && typeof (callbackResult as { then?: unknown }).then === "function") {
						void Promise.resolve(callbackResult).catch(failStream);
					}
				} catch (error) {
					failStream(error);
				}
			};
			const execSignal = signal ? AbortSignal.any([signal, callbackAbort.signal]) : callbackAbort.signal;
			const attest = host.attestSessionSpawn;
			let attestation: { release(): unknown } | undefined;
			const onSpawn =
				attest === undefined || sessionId === undefined
					? host.onSpawn
					: (pid: number) => {
							attestation = attest(sessionId, pid);
							host.onSpawn?.(pid);
						};
			const onExit =
				attest === undefined || sessionId === undefined
					? host.onExit
					: (pid: number) => {
							void attestation?.release();
							host.onExit?.(pid);
						};
			let result: Awaited<ReturnType<typeof machine.ops.process.exec>>;
			try {
				result = await machine.ops.process.exec(
					{
						command,
						cwd,
						env: env ?? host.defaultEnv(),
						envMode: host.envMode,
						...(shell !== undefined ? { shell } : {}),
						timeoutMs: timeoutMs ?? Number.POSITIVE_INFINITY,
						onOutput: handleData,
						...(onSpawn !== undefined ? { onSpawn } : {}),
						...(onExit !== undefined ? { onExit } : {}),
					},
					machine.context(execSignal),
				);
			} catch (error) {
				if (hasStreamCallbackError) throw streamCallbackError;
				if (signal?.aborted) throw new Error("aborted");
				throw error;
			} finally {
				host.afterExec?.();
			}
			if (hasStreamCallbackError) {
				throw streamCallbackError;
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			if (result.timedOut) {
				throw new Error(`timeout:${timeout}`);
			}
			// A signal-killed shell has no exit code. Use the standard shell convention so
			// callers do not mistake the termination for a successful command.
			return {
				exitCode: result.exitCode ?? (result.signal ? 128 + (host.signalNumber(result.signal) ?? 0) : 1),
			};
		},
	};
}
