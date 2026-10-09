import { type ChildProcess, spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { runtimeExecArgv } from "../../../utils/runtime-exec-argv.ts";
import type { AppServerListen } from "../cli-args.ts";
import { cleanupState } from "./probe.ts";
import { readProcessStartTime, waitForStartTime } from "./process.ts";

export type DaemonExit =
	| { readonly kind: "error"; readonly error: Error }
	| { readonly kind: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type SpawnedDaemon = {
	readonly pid: number;
	readonly exited: Promise<DaemonExit>;
};

/** What a daemon is launched with; recorded in settings.json so `restart` relaunches the same daemon. */
export type DaemonLaunchIntent = {
	readonly listen: AppServerListen;
	readonly extensions: readonly string[];
};

type SpawnPaths = {
	readonly pidFile: string;
	readonly settingsFile: string;
	readonly stderrLog: string;
};

export async function spawnDaemon(
	paths: SpawnPaths,
	intent: DaemonLaunchIntent,
	cliMainPath: string,
): Promise<SpawnedDaemon> {
	const { listen, extensions } = intent;
	const stderr = await open(paths.stderrLog, "w");
	try {
		const daemonExec = process.versions.bun
			? process.env.npm_node_execpath && !/[/\\]bun(?:$|[/\\])/.test(process.env.npm_node_execpath)
				? process.env.npm_node_execpath
				: "/opt/homebrew/bin/node"
			: process.execPath;
		const child = spawn(
			daemonExec,
			[
				...(process.versions.bun ? [] : runtimeExecArgv()),
				cliMainPath,
				"app-server",
				"--listen",
				listen.url,
				...extensions.flatMap((extension) => ["--extension", extension]),
			],
			{
				detached: true,
				windowsHide: true,
				env: { ...process.env, SENPI_RUNTIME: "node" },
				stdio: ["ignore", "ignore", stderr.fd],
			},
		);
		const exited = observeDaemonExit(child);
		const pid = child.pid;
		if (pid === undefined) throw new Error("failed to spawn daemon process");
		let startTime: string;
		try {
			const observed = await Promise.race([
				waitForStartTime(pid, 10_000),
				exited.then(() => {
					throw new Error(`spawned daemon ${pid} exited before its start time could be read`);
				}),
			]);
			// UNKNOWN identity on a live daemon means the probe was starved, not that startup failed.
			// The per-attempt win32 probe budget is 1s, which a loaded runner exceeds every time, so
			// take one unhurried read before treating an unreadable identity as a startup error.
			const resolved =
				observed ?? (await readProcessStartTime(pid, process.platform, 15_000).catch(() => undefined));
			if (resolved === undefined) {
				throw new Error(`spawned daemon ${pid} started but its process identity stayed unreadable`);
			}
			startTime = resolved;
		} catch (error: unknown) {
			// Keep the handle owned until registration succeeds. This terminates the
			// exact child even when start-time acquisition fails, without a raw PID.
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGTERM");
				} catch {}
				await Promise.race([exited, delay(2_000)]);
				if (child.exitCode === null && child.signalCode === null) {
					try {
						child.kill("SIGKILL");
					} catch {}
				}
			}
			await cleanupState(paths, listen);
			throw error;
		}
		try {
			await writeFile(paths.pidFile, `${JSON.stringify({ pid, processStartTime: startTime })}\n`, { mode: 0o600 });
			await writeFile(paths.settingsFile, `${JSON.stringify({ listen, extensions })}\n`, { mode: 0o600 });
		} catch (error: unknown) {
			// Registration is the ownership hand-off point. Until both files exist,
			// retain the exact ChildProcess handle and terminate it on any write
			// failure so a partial registration can never leave an unmanaged daemon.
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGTERM");
				} catch {}
				await Promise.race([exited, delay(2_000)]);
				if (child.exitCode === null && child.signalCode === null) {
					try {
						child.kill("SIGKILL");
					} catch (killError: unknown) {
						throw new Error(
							`failed to terminate daemon after registration failure: ${killError instanceof Error ? killError.message : String(killError)}`,
						);
					}
					if (!(await Promise.race([exited.then(() => true), delay(2_000).then(() => false)]))) {
						throw new Error(`daemon ${pid} remained alive after SIGKILL during registration failure`);
					}
				}
			}
			await cleanupState(paths, { ...listen, ...(listen.kind === "unix" ? { path: undefined } : {}) });
			throw error;
		}
		child.unref();
		return { pid, exited };
	} finally {
		await stderr.close();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function observeDaemonExit(child: ChildProcess): Promise<DaemonExit> {
	return new Promise((resolveExit) => {
		child.once("error", (error) => resolveExit({ kind: "error", error }));
		child.once("exit", (code, signal) => resolveExit({ kind: "exit", code, signal }));
	});
}
