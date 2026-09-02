/**
 * Opt-in supervisor-lifetime watchdog for the RPC socket host.
 *
 * A host started under the `host-lifecycle.ts` supervisor must not outlive it.
 * Catchable signals cannot carry that guarantee: `kill -9`, an OOM kill, or a
 * crashed supervisor run no JS handler, and the host is then reparented to init
 * as a permanent orphan holding its private socket forever.
 *
 * The binding used here is the OS itself. The supervisor spawns the host with an
 * extra inherited pipe and keeps the write end open without ever writing to it.
 * The kernel closes that end when the supervisor dies for ANY reason, so the
 * host's read end reaches EOF and the host shuts down cleanly.
 *
 * Both variables are unset for every other host launch, so nothing changes for
 * plain `senpi --mode rpc` runs, hosts started by hand, or embedders.
 */
import { createReadStream, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { envValue } from "../../core/brand.ts";
import { readProcessIdentity } from "../app-server/daemon/process.ts";

/** Inherited fd whose EOF means "the supervisor died"; set by the supervisor only. */
export const HOST_WATCH_FD_ENV = "SENPI_RPC_HOST_WATCH_FD";
/** Supervisor-owned private directory the host removes on watchdog shutdown. */
export const HOST_SCRATCH_DIR_ENV = "SENPI_RPC_HOST_SCRATCH_DIR";
/** Fallback binding when no inherited fd is available: poll this pid. */
export const HOST_WATCH_PPID_ENV = "SENPI_RPC_HOST_WATCH_PPID";
/** Poll cadence for the ppid fallback. */
export const HOST_WATCH_PPID_INTERVAL_MS = 250;
/** Bound the Windows PowerShell identity probe so one stuck query cannot stop future polls. */
const HOST_WATCH_PPID_PROBE_TIMEOUT_MS = 1_000;
export const HOST_CLEANUP_PATHS_ENV = "SENPI_RPC_HOST_CLEANUP_PATHS";

export interface HostWatchdogConfig {
	readonly fd?: number;
	readonly ppid?: number;
	readonly scratchDir?: string;
	readonly cleanupPaths?: readonly string[];
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Reads the watchdog configuration from the environment. Returns `undefined`
 * when neither binding is requested, which is the case for every host launch
 * that does not come from the lifecycle supervisor.
 */
export function readHostWatchdogConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
): HostWatchdogConfig | undefined {
	const fd = parsePositiveInteger(env[HOST_WATCH_FD_ENV]);
	const ppid = parsePositiveInteger(env[HOST_WATCH_PPID_ENV]);
	if (fd === undefined && ppid === undefined) return undefined;
	const scratchDir = env[HOST_SCRATCH_DIR_ENV];
	const cleanupPaths = env[HOST_CLEANUP_PATHS_ENV]?.split("\n").filter(Boolean);
	return {
		fd,
		ppid,
		scratchDir: scratchDir === undefined || scratchDir === "" ? undefined : scratchDir,
		cleanupPaths,
	};
}

/** Same configuration, resolved through the brand-aware env prefixes. */
export function readHostWatchdogConfigFromBrandEnv(): HostWatchdogConfig | undefined {
	// The lifecycle supervisor intentionally uses the canonical SENPI_RPC_HOST_*
	// names when spawning a child. envValue() resolves branded aliases for normal
	// launches, but must not hide the canonical variables from the supervisor
	// handoff or the lifetime binding is silently disabled.
	return readHostWatchdogConfig({
		[HOST_WATCH_FD_ENV]: process.env[HOST_WATCH_FD_ENV] ?? envValue("RPC_HOST_WATCH_FD"),
		[HOST_WATCH_PPID_ENV]: process.env[HOST_WATCH_PPID_ENV] ?? envValue("RPC_HOST_WATCH_PPID"),
		[HOST_SCRATCH_DIR_ENV]: process.env[HOST_SCRATCH_DIR_ENV] ?? envValue("RPC_HOST_SCRATCH_DIR"),
		[HOST_CLEANUP_PATHS_ENV]: process.env[HOST_CLEANUP_PATHS_ENV] ?? envValue("RPC_HOST_CLEANUP_PATHS"),
	});
}

/**
 * Arms the configured watchdog. `onSupervisorGone` receives the reason and is
 * expected to perform the host's normal clean shutdown; the scratch directory
 * (the supervisor's private socket directory, which no longer has an owner) is
 * removed first so nothing is left behind even if shutdown then hangs.
 *
 * Takes ownership of `config.fd`: disarming (or firing) closes it, so callers
 * must not close it themselves. Returns a disarm function; a no-op when no
 * binding is configured.
 */
export function armHostWatchdog(
	config: HostWatchdogConfig | undefined,
	onSupervisorGone: (reason: string, cleanup?: Promise<void>) => void,
): () => void {
	if (!config) return () => {};
	const fire = (reason: string): void => {
		disarm();
		if (process.platform === "win32") {
			// Arm the host shutdown fallback before attempting metadata cleanup. The
			// synchronous Win32 removal below handles the state files deterministically,
			// while the fallback still covers a named-pipe close that never completes.
			const cleanup = Promise.resolve().then(() => cleanupWatchdogPaths(config));
			onSupervisorGone(reason, cleanup);
		} else {
			void cleanupWatchdogPaths(config).finally(() => onSupervisorGone(reason));
		}
	};
	const disarmers: Array<() => void> = [];
	const disarm = (): void => {
		for (const stop of disarmers.splice(0)) stop();
	};
	if (config.fd !== undefined) disarmers.push(watchFdForEof(config.fd, fire));
	if (config.ppid !== undefined) disarmers.push(watchPpid(config.ppid, fire));
	return disarm;
}

/**
 * EOF on the inherited pipe is the primary signal. The supervisor never writes
 * to it, so any readable data is ignored; only close matters. An fd that cannot
 * be opened (never inherited) leaves the binding inert rather than killing a
 * healthy host.
 */
function watchFdForEof(fd: number, fire: (reason: string) => void): () => void {
	let stream: ReturnType<typeof createReadStream>;
	let streamFailed = false;
	let fired = false;
	const fireOnce = (reason: string): void => {
		if (fired) return;
		fired = true;
		fire(reason);
	};
	try {
		// The watchdog owns this inherited read end. autoClose is required on
		// Win32 so the stream releases fd 3 and observes the pipe's terminal close.
		stream = createReadStream("", { fd, autoClose: true });
	} catch {
		return () => {};
	}
	stream.resume();
	const onEnd = (): void => fireOnce(`supervisor pipe fd ${fd} closed`);
	const onClose = (): void => {
		if (!streamFailed) onEnd();
	};
	const onError = (): void => {
		streamFailed = true;
	};
	stream.once("end", onEnd);
	// Win32 pipe teardown may report close without end; POSIX invalid-fd close is
	// not supervisor death and remains inert.
	if (process.platform === "win32") stream.once("close", onClose);
	stream.once("error", onError);
	return () => {
		stream.off("end", onEnd);
		stream.off("close", onClose);
		stream.off("error", onError);
		stream.destroy();
	};
}

/**
 * Fallback binding: the supervisor pid is gone, or this process was reparented
 * to init because the supervisor died. Polling covers the case where no extra
 * fd could be inherited.
 */
function watchPpid(supervisorPid: number, fire: (reason: string) => void): () => void {
	let checking = false;
	let missingIdentityChecks = 0;
	// Tests and embedders may bind the watchdog to this process itself; that
	// is a valid live binding rather than evidence of supervisor loss.
	if (supervisorPid === process.pid) return () => {};
	const timer = setInterval(() => {
		if (!processAlive(supervisorPid)) {
			fire(`supervisor pid ${supervisorPid} is gone (ppid=${process.ppid})`);
			return;
		}
		if (checking) return;
		checking = true;
		void readProcessIdentity(supervisorPid, process.platform, HOST_WATCH_PPID_PROBE_TIMEOUT_MS)
			.then((result) => {
				if (result.kind === "error") return;
				if (result.kind === "absent") missingIdentityChecks++;
				else missingIdentityChecks = 0;
				if (process.ppid === supervisorPid && result.kind === "present") return;
				if (process.ppid === supervisorPid && missingIdentityChecks < 3) return;
				fire(`supervisor pid ${supervisorPid} is gone (ppid=${process.ppid})`);
			})
			.finally(() => {
				checking = false;
			});
	}, HOST_WATCH_PPID_INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return cause instanceof Error && "code" in cause && cause.code !== "ESRCH";
	}
}

async function cleanupWatchdogPaths(config: HostWatchdogConfig): Promise<void> {
	const paths = [...(config.cleanupPaths ?? []), ...(config.scratchDir ? [config.scratchDir] : [])];
	if (process.platform === "win32") {
		for (const path of paths) {
			try {
				rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch {}
		}
		return;
	}
	await Promise.all(
		paths.map(async (path) => {
			try {
				await rm(path, { recursive: true, force: true });
			} catch {}
		}),
	);
}
