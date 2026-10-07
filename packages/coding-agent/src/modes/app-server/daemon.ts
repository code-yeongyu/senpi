import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../config.ts";
import { acquireOwnershipSafeLock } from "../rpc/ownership-safe-lock.ts";
import { inspectAppServerListenOccupancy } from "./daemon/occupancy.ts";
import {
	cleanupState,
	pollProbe,
	probeListen,
	readSettings,
	runningOutput,
	runningUnmanagedOutput,
} from "./daemon/probe.ts";
import {
	type DaemonPidFile,
	parseDaemonPidFile,
	processMatchesPidFile,
	readProcessStartTime,
	stopValidatedPid,
	waitForGone,
} from "./daemon/process.ts";
import { type DaemonExit, type DaemonLaunchIntent, spawnDaemon } from "./daemon/spawn.ts";
import { resolveAppServerExtensionPaths } from "./extension-paths.ts";
import type { AppServerDaemonCommandOptions, AppServerListen } from "./index.ts";

export interface DaemonPaths {
	readonly dir: string;
	readonly pidFile: string;
	readonly lockFile: string;
	readonly settingsFile: string;
	readonly stderrLog: string;
	readonly tokenFile: string;
}

type DaemonOutput = Readonly<Record<string, string | number | undefined>>;

type DaemonReadiness =
	| { readonly kind: "ready"; readonly version: string }
	| { readonly kind: "timed-out" }
	| { readonly kind: "exited"; readonly exit: DaemonExit };

const lockOptions = { retries: { retries: 100, minTimeout: 20, maxTimeout: 100 } } as const;

export function createDaemonPaths(agentDir = getAgentDir()): DaemonPaths {
	const dir = join(agentDir, "app-server-daemon");
	return {
		dir,
		pidFile: join(dir, "app-server.pid"),
		lockFile: join(dir, "daemon.lock"),
		settingsFile: join(dir, "settings.json"),
		stderrLog: join(dir, "stderr.log"),
		tokenFile: join(agentDir, "app-server", "ws-token"),
	};
}

export async function withDaemonStateLock<T>(paths: DaemonPaths, task: () => Promise<T>): Promise<T> {
	await mkdir(paths.dir, { recursive: true });
	const release = await acquireOwnershipSafeLock(paths.lockFile, lockOptions);
	try {
		return await task();
	} finally {
		await release();
	}
}

export async function runAppServerDaemonCommand(options: AppServerDaemonCommandOptions): Promise<void> {
	const paths = createDaemonPaths();
	const output = await withDaemonStateLock(paths, async () => {
		try {
			return await runLockedDaemonCommand(options, paths);
		} catch (error: unknown) {
			process.exitCode = 1;
			return { status: "error", message: error instanceof Error ? error.message : String(error) };
		}
	});
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function runLockedDaemonCommand(
	options: AppServerDaemonCommandOptions,
	paths: DaemonPaths,
): Promise<DaemonOutput> {
	const settings = await readSettings(paths);
	const listen = options.verb === "start" ? options.listen : (settings?.listen ?? options.listen);
	const extensions = resolveAppServerExtensionPaths(options.extensions);
	switch (options.verb) {
		case "start":
			return startDaemon(paths, { listen, extensions });
		case "stop":
			return stopDaemon(paths, listen);
		case "status":
			return statusDaemon(paths, listen);
		case "restart": {
			// Like the listener, a restart relaunches what was recorded; explicit extensions replace it.
			const restartListen = settings?.listen ?? options.listen;
			await stopDaemon(paths, restartListen);
			return startDaemon(paths, {
				listen: restartListen,
				extensions: extensions.length > 0 ? extensions : (settings?.extensions ?? []),
			});
		}
	}
}

async function startDaemon(paths: DaemonPaths, intent: DaemonLaunchIntent): Promise<DaemonOutput> {
	const { listen } = intent;
	const occupancy = await inspectAppServerListenOccupancy(paths, listen);
	if (occupancy.kind === "app-server") {
		const pidFile = await readPidFile(paths);
		const pid = pidFile && (await processMatchesPidFile(pidFile)) ? pidFile.pid : undefined;
		if (pid !== undefined) return runningOutput("already-running", pid, listen, occupancy.version);
		return { status: "already-running", listen: listen.url, version: occupancy.version };
	}
	const pidFile = await readPidFile(paths);
	if (pidFile && (await processMatchesPidFile(pidFile))) {
		const lateProbe = await pollProbe(paths, listen, 10_000);
		if (lateProbe) return runningOutput("already-running", pidFile.pid, listen, lateProbe);
		throw new Error(`managed daemon pid ${pidFile.pid} did not answer initialize`);
	}
	const spawned = await spawnDaemon(paths, intent, resolveCliMainPath());
	const readiness = await waitForDaemonReady(paths, listen, spawned.exited);
	if (readiness.kind === "ready") {
		return { status: "started", pid: spawned.pid, listen: listen.url };
	}
	await stopValidatedPid(
		{ pid: spawned.pid, processStartTime: (await readProcessStartTime(spawned.pid)) ?? "" },
		"SIGTERM",
	);
	const message =
		readiness.kind === "exited"
			? `spawned daemon ${describeDaemonExit(readiness.exit)} before answering initialize`
			: "spawned daemon did not answer initialize within 10s";
	const diagnostic = await appendDaemonStderr(paths, message);
	await cleanupState(paths, listen);
	throw new Error(diagnostic);
}

async function stopDaemon(paths: DaemonPaths, listen: AppServerListen): Promise<DaemonOutput> {
	const pidFile = await readPidFile(paths);
	if (!pidFile) {
		if (!(await probeListen(paths, listen, 2_000))) await cleanupState(paths, listen);
		return { status: "not-running" };
	}
	if (!(await processMatchesPidFile(pidFile))) {
		await cleanupState(paths, listen);
		return { status: "not-running" };
	}
	await stopValidatedPid(pidFile, "SIGTERM");
	if (await processMatchesPidFile(pidFile)) {
		await stopValidatedPid(pidFile, "SIGKILL");
	}
	await waitForGone(pidFile, 10_000);
	await cleanupState(paths, listen);
	return { status: "stopped" };
}

async function statusDaemon(paths: DaemonPaths, listen: AppServerListen): Promise<DaemonOutput> {
	const probe = await probeListen(paths, listen, 2_000);
	const pidFile = await readPidFile(paths);
	const pidMatches = pidFile ? await processMatchesPidFile(pidFile) : false;
	if (probe && pidFile && pidMatches) return runningOutput("running", pidFile.pid, listen, probe);
	if (probe) return runningUnmanagedOutput(listen, probe);
	if (pidFile && !pidMatches) await cleanupState(paths, listen);
	return { status: "not-running" };
}

async function waitForDaemonReady(
	paths: DaemonPaths,
	listen: AppServerListen,
	exited: Promise<DaemonExit>,
): Promise<DaemonReadiness> {
	const controller = new AbortController();
	try {
		const probe = pollProbe(paths, listen, 10_000, controller.signal).then(
			(version): DaemonReadiness => (version ? { kind: "ready", version } : { kind: "timed-out" }),
		);
		const childExit = exited.then((exit): DaemonReadiness => ({ kind: "exited", exit }));
		return await Promise.race([probe, childExit]);
	} finally {
		controller.abort();
	}
}

function describeDaemonExit(exit: DaemonExit): string {
	if (exit.kind === "error") return `failed to launch (${exit.error.message})`;
	if (exit.signal) return `was terminated by ${exit.signal}`;
	return `exited with code ${exit.code ?? "unknown"}`;
}

async function appendDaemonStderr(paths: DaemonPaths, message: string): Promise<string> {
	try {
		const stderr = (await readFile(paths.stderrLog, "utf8")).trim();
		return stderr ? `${message}\n${stderr}` : message;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return message;
		throw error;
	}
}

async function readPidFile(paths: DaemonPaths): Promise<DaemonPidFile | undefined> {
	try {
		return parseDaemonPidFile(await readFile(paths.pidFile, "utf8"));
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function resolveCliMainPath(): string {
	const modulePath = fileURLToPath(import.meta.url);
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	return resolve(dirname(modulePath), "..", "..", `cli-main${extension}`);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
