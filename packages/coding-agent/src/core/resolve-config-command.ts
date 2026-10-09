/**
 * Run a `!command` config value (credential helper, header broker) off the event loop.
 *
 * Every wait in here is asynchronous on purpose: an RPC host runs every session on one
 * event loop, so a synchronous spawn or a blocking backoff freezes every other session
 * for as long as the helper runs.
 */

import { spawn } from "child_process";
import { getShellConfig } from "../utils/shell.ts";
import { sleep } from "../utils/sleep.ts";

// Credential helper commands (auth brokers like `omp token …`) are cold-started on
// every invocation and can fail transiently — broker lock contention, a slow spawn
// under load, an OAuth refresh racing another process. A single failed attempt must
// not read as "credential gone": callers escalate an unresolved API key to a
// hard-error provider ejection, so one blip would kick the session off its model
// without any retry. Retry with a short backoff before giving up.
const COMMAND_EXECUTION_MAX_ATTEMPTS = 3;
const COMMAND_EXECUTION_BACKOFF_MS = [250, 1000] as const;
const COMMAND_TIMEOUT_MS = 10000;
/** The child_process default `maxBuffer`: a runaway helper never grows the host. */
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

/** `executed` separates "the shell ran and produced nothing" from "the shell is missing". */
type CommandOutcome = { executed: boolean; value: string | undefined };

type CommandProcessOptions = {
	/** Run through the platform shell (`sh -c`, `cmd /c`) instead of exec'ing the file. */
	readonly shell: boolean;
	readonly stdin?: string;
	readonly env?: Record<string, string>;
};

function runCommandProcess(
	file: string,
	args: readonly string[],
	options: CommandProcessOptions,
): Promise<CommandOutcome> {
	return new Promise((resolveOutcome) => {
		// Two literal stdio tuples rather than one computed array: they are what types
		// `child.stdout` as a stream instead of `Readable | null`.
		const spawnOptions = {
			shell: options.shell,
			windowsHide: true,
			...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
		};
		const child =
			options.stdin === undefined
				? spawn(file, [...args], { ...spawnOptions, stdio: ["ignore", "pipe", "ignore"] })
				: spawn(file, [...args], { ...spawnOptions, stdio: ["pipe", "pipe", "ignore"] });
		let stdout = "";
		let settled = false;
		const finish = (outcome: CommandOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveOutcome(outcome);
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			// A helper that ignored the deadline must not keep the host alive either.
			child.unref();
			finish({ executed: true, value: undefined });
		}, COMMAND_TIMEOUT_MS);
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length <= COMMAND_MAX_OUTPUT_BYTES) return;
			child.kill("SIGTERM");
			finish({ executed: true, value: undefined });
		});
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish({ executed: error.code !== "ENOENT", value: undefined }),
		);
		child.on("close", (code) => {
			const value = stdout.trim();
			finish({ executed: true, value: code === 0 && value ? value : undefined });
		});
		child.stdin?.end(options.stdin);
	});
}

/** Windows shells are configured, not assumed; a broken configuration falls back below. */
async function executeWithConfiguredShell(command: string, env?: Record<string, string>): Promise<CommandOutcome> {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		return await runCommandProcess(shell, commandFromStdin ? args : [...args, command], {
			shell: false,
			...(commandFromStdin ? { stdin: command } : {}),
			...(env === undefined ? {} : { env }),
		});
	} catch {
		// getShellConfig throws when the configured shell path is missing.
		return { executed: false, value: undefined };
	}
}

async function executeCommandOnce(command: string, env?: Record<string, string>): Promise<string | undefined> {
	if (process.platform === "win32") {
		const configured = await executeWithConfiguredShell(command, env);
		if (configured.executed) return configured.value;
	}
	const result = await runCommandProcess(command, [], {
		shell: true,
		...(env === undefined ? {} : { env }),
	});
	return result.value;
}

/** Execute a `!command` config value, retrying a transient failure with an awaited backoff. */
export async function runConfigCommand(
	commandConfig: string,
	env?: Record<string, string>,
): Promise<string | undefined> {
	const command = commandConfig.slice(1);
	for (let attempt = 0; attempt < COMMAND_EXECUTION_MAX_ATTEMPTS; attempt++) {
		const value = await executeCommandOnce(command, env);
		if (value !== undefined) return value;
		const backoffMs = COMMAND_EXECUTION_BACKOFF_MS[attempt];
		if (backoffMs !== undefined) await sleep(backoffMs);
	}
	return undefined;
}
