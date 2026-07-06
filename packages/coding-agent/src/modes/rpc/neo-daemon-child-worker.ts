/**
 * Production worker factory for the neo daemon: one child `senpi --mode rpc`
 * process per connection.
 *
 * Each child is a standard single-connection rpc runtime with its own module
 * state and its own AuthStorage, so a connection's `--api-key` (passed as argv)
 * lives only in that child — the auth-isolation guarantee is structural. The
 * connection socket is bridged to the child's stdio: client lines → child stdin,
 * child stdout → client socket. On dispose the child is aborted (SIGTERM, then
 * SIGKILL after a grace period).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { attachJsonlLineReader } from "./jsonl.ts";
import type { NeoDaemonWorker, NeoDaemonWorkerFactory } from "./neo-daemon-mode.ts";
import { neoRuntimeOptionsToRpcArgv } from "./neo-runtime-options-argv.ts";

export interface NeoChildWorkerConfig {
	/** Executable to run (default: the current node binary). */
	readonly execPath?: string;
	/** Fixed leading args before the runtime argv (e.g. [cliEntryPath]). */
	readonly baseArgs: readonly string[];
	/** Grace period before SIGKILL after SIGTERM, in ms. */
	readonly killGraceMs?: number;
}

/**
 * Build a worker factory that spawns child rpc processes.
 *
 * `baseArgs` should locate the CLI entry, e.g. `[join(distDir, "rpc-entry.js")]`
 * or `[tsxLoader, cliEntry]` in dev. The connection's runtimeOptions are
 * appended as classic argv (see neoRuntimeOptionsToRpcArgv).
 */
export function createNeoChildWorkerFactory(config: NeoChildWorkerConfig): NeoDaemonWorkerFactory {
	const execPath = config.execPath ?? process.execPath;
	const killGraceMs = config.killGraceMs ?? 3000;

	return async ({ runtimeOptions, cwd, agentDir, writeToClient, signal }): Promise<NeoDaemonWorker> => {
		const runtimeArgv = neoRuntimeOptionsToRpcArgv(runtimeOptions);
		// neoRuntimeOptionsToRpcArgv already prepends ["--mode","rpc"]; strip it if
		// baseArgs points at rpc-entry (which injects --mode rpc itself). We keep it
		// simple and always pass through cli-main-style args; rpc-entry tolerates a
		// duplicate --mode rpc because parseArgs takes the last one.
		const child: ChildProcess = spawn(execPath, [...config.baseArgs, ...runtimeArgv], {
			cwd,
			env: {
				...process.env,
				SENPI_CODING_AGENT_DIR: agentDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdout = child.stdout;
		const stdin = child.stdin;
		if (!stdout || !stdin) {
			child.kill("SIGKILL");
			throw new Error("Failed to open child worker stdio");
		}

		// Child stdout (JSONL) → client socket, line-framed so partial chunks never
		// split a record across the socket boundary.
		const detachStdout = attachJsonlLineReader(stdout, (line) => {
			writeToClient(`${line}\n`);
		});

		// Surface child stderr as a diagnostic event line without leaking secrets:
		// stderr is forwarded verbatim only in dev builds; here it is dropped to
		// avoid mixing non-JSONL bytes into the client stream. Errors that matter
		// arrive as rpc error responses on stdout.
		child.stderr?.resume();

		let disposed = false;
		const dispose = async (): Promise<void> => {
			if (disposed) return;
			disposed = true;
			detachStdout();
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) {
							child.kill("SIGKILL");
						}
						resolve();
					}, killGraceMs);
					child.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
		};

		signal.addEventListener("abort", () => void dispose(), { once: true });

		return {
			handleLine(line: string): void {
				if (!disposed && stdin.writable) {
					stdin.write(`${line}\n`);
				}
			},
			dispose,
		};
	};
}
