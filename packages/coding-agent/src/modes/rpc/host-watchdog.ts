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
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { envValue } from "../../core/brand.ts";

/** Inherited fd whose EOF means "the supervisor died"; set by the supervisor only. */
export const HOST_WATCH_FD_ENV = "SENPI_RPC_HOST_WATCH_FD";
/** Supervisor-owned private directory the host removes on watchdog shutdown. */
export const HOST_SCRATCH_DIR_ENV = "SENPI_RPC_HOST_SCRATCH_DIR";
/** Fallback binding when no inherited fd is available: poll this pid. */
export const HOST_WATCH_PPID_ENV = "SENPI_RPC_HOST_WATCH_PPID";
/** Poll cadence for the ppid fallback. */
export const HOST_WATCH_PPID_INTERVAL_MS = 2_000;

export interface HostWatchdogConfig {
	readonly fd?: number;
	readonly ppid?: number;
	readonly scratchDir?: string;
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
	return { fd, ppid, scratchDir: scratchDir === undefined || scratchDir === "" ? undefined : scratchDir };
}

/** Same configuration, resolved through the brand-aware env prefixes. */
export function readHostWatchdogConfigFromBrandEnv(): HostWatchdogConfig | undefined {
	return readHostWatchdogConfig({
		[HOST_WATCH_FD_ENV]: envValue("RPC_HOST_WATCH_FD"),
		[HOST_WATCH_PPID_ENV]: envValue("RPC_HOST_WATCH_PPID"),
		[HOST_SCRATCH_DIR_ENV]: envValue("RPC_HOST_SCRATCH_DIR"),
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
	onSupervisorGone: (reason: string) => void,
): () => void {
	if (!config) return () => {};
	const fire = (reason: string): void => {
		disarm();
		void cleanupScratchDir(config.scratchDir).finally(() => onSupervisorGone(reason));
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
	try {
		stream = createReadStream("", { fd, autoClose: false });
	} catch {
		return () => {};
	}
	stream.resume();
	const onEnd = (): void => fire(`supervisor pipe fd ${fd} closed`);
	stream.once("end", onEnd);
	// A read error means the pipe is unusable, which is indistinguishable from a
	// dead supervisor from this side; treating it as EOF keeps the binding safe.
	stream.once("error", onEnd);
	return () => {
		stream.off("end", onEnd);
		stream.off("error", onEnd);
		stream.destroy();
	};
}

/**
 * Fallback binding: the supervisor pid is gone, or this process was reparented
 * to init because the supervisor died. Polling covers the case where no extra
 * fd could be inherited.
 */
function watchPpid(supervisorPid: number, fire: (reason: string) => void): () => void {
	const timer = setInterval(() => {
		if (process.ppid === supervisorPid && processAlive(supervisorPid)) return;
		fire(`supervisor pid ${supervisorPid} is gone (ppid=${process.ppid})`);
	}, HOST_WATCH_PPID_INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return cause instanceof Error && "code" in cause && cause.code === "EPERM";
	}
}

async function cleanupScratchDir(scratchDir: string | undefined): Promise<void> {
	if (scratchDir === undefined) return;
	try {
		await rm(scratchDir, { recursive: true, force: true });
	} catch {
		/* best effort: the host is exiting either way. */
	}
}
