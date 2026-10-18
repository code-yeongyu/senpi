import { parseIdleExitMs } from "./host-lifecycle-policy.ts";
import { ownGenerationDir, writeHeartbeat, writeStallEvidence } from "./host-stalled-evidence.ts";
import { recordLoopBlockedMs } from "./loop-blocked-time.ts";
import { loopLagErrorMs } from "./loop-lag-threshold.ts";
import type { RpcHostStalledEvent } from "./rpc-types.ts";
import { type SessionAttribution, sessionActivityMark, sessionActivitySince } from "./session-attribution.ts";

/** Environment override for the drift that logs a warning, in milliseconds. */
export const LOOP_LAG_WARN_MS_ENV = "SENPI_RPC_LOOP_LAG_WARN_MS";
export const DEFAULT_LOOP_LAG_WARN_MS = 500;
export { DEFAULT_LOOP_LAG_ERROR_MS, LOOP_LAG_ERROR_MS_ENV, loopLagErrorMs } from "./loop-lag-threshold.ts";
/** Measurement interval: short enough to bound the blamed window, cheap enough to ignore. */
export const LOOP_LAG_TICK_MS = 200;
/** One warning per window, however many stalls it covers. */
export const LOOP_LAG_WARN_INTERVAL_MS = 10_000;

/**
 * A heartbeat is refreshed at most once per this fraction of the stall threshold: a reader calls the host
 * stalled only once the heartbeat is older than the threshold, so a beat this often keeps it at most a
 * fifth stale without a disk write on every 200 ms tick.
 */
const HEARTBEAT_THRESHOLD_FRACTION = 5;

export interface LoopLagWatchdogOptions {
	/** Delivers one `host_stalled` lifecycle record to every connection. */
	readonly emit: (record: RpcHostStalledEvent) => void;
	/** Defaults to one stderr line; tests capture it. */
	readonly log?: (message: string) => void;
	readonly now?: () => number;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Process CPU time in microseconds; defaults to `process.cpuUsage()`. */
	readonly cpuUsage?: () => { readonly user: number; readonly system: number };
	/** Live JS heap in bytes; defaults to `process.memoryUsage().heapUsed`. */
	readonly heapUsed?: () => number;
	/** Refreshes the generation's heartbeat file; defaults to `writeHeartbeat`. */
	readonly writeHeartbeat?: (generationDir: string, at: string) => Promise<void>;
}

const BYTES_PER_MB = 1024 * 1024;

function describeWindow(processCpuMs: number, heapDeltaMb: number): string {
	return `cpu=${processCpuMs}ms heap=${heapDeltaMb >= 0 ? "+" : ""}${heapDeltaMb}MB`;
}

function describeAttribution(attribution: SessionAttribution | undefined): string {
	if (attribution?.sessionId === undefined && attribution?.tool === undefined) return "no attributed session";
	return `sessionId=${attribution.sessionId ?? "unknown"}${attribution.tool ? ` tool=${attribution.tool}` : ""}`;
}

/**
 * Event-loop stall detector for the shared host.
 *
 * Every in-process session runs on the host's one event loop, so a session that blocks
 * it freezes every other session and the transport with it. A 200 ms timer measures how
 * late it is actually invoked: that lateness IS the time the loop spent unable to serve
 * anyone. Past the warning threshold the host says so once per 10 s, naming the session
 * and tool whose work held the loop; past the error threshold it also emits a
 * `host_stalled` lifecycle record so attached clients (and the desktop) can show it.
 *
 * Every stall also carries the process CPU time and the heap movement of the stalled
 * window, so it explains itself (senpi#2211): CPU near the drift means the host was busy
 * (a heap drop in the same window points at a collection); CPU near zero means the
 * process did not run - the machine starved it or it sat in a blocking wait.
 *
 * The watchdog only reports. It never aborts a turn, kills a session, or refuses work.
 */
export class LoopLagWatchdog {
	private readonly emit: (record: RpcHostStalledEvent) => void;
	private readonly log: (message: string) => void;
	private readonly now: () => number;
	private readonly warnMs: number;
	private readonly errorMs: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private expectedTickAt: number | undefined;
	private activityMark = 0;
	private lastWarnAt: number | undefined;
	private readonly cpuUsage: () => { readonly user: number; readonly system: number };
	private readonly heapUsed: () => number;
	private cpuMicrosAtTick = 0;
	private heapBytesAtTick = 0;
	/** This host's own generation directory when a supervisor launched it; evidence goes nowhere else. */
	private readonly evidenceDir: string | undefined;
	private heartbeatInFlight = false;
	private lastHeartbeatAt: number | undefined;
	private readonly heartbeatIntervalMs: number;
	private readonly writeHeartbeat: (generationDir: string, at: string) => Promise<void>;
	/**
	 * The parent this host was launched under. Once it is gone the host is orphaned and on its way out:
	 * its generation directory belongs to nobody now (gc may be judging or removing it), so the host
	 * stops writing evidence there instead of racing that with a heartbeat a dying process may leave torn.
	 */
	private readonly launchParentPid = process.ppid;
	private evidenceFailureLogged = false;

	constructor(options: LoopLagWatchdogOptions) {
		const env = options.env ?? process.env;
		this.emit = options.emit;
		this.log = options.log ?? ((message) => void process.stderr.write(message));
		this.now = options.now ?? Date.now;
		this.cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
		this.heapUsed = options.heapUsed ?? (() => process.memoryUsage().heapUsed);
		this.writeHeartbeat = options.writeHeartbeat ?? writeHeartbeat;
		this.warnMs = parseIdleExitMs(env[LOOP_LAG_WARN_MS_ENV]) ?? DEFAULT_LOOP_LAG_WARN_MS;
		this.errorMs = loopLagErrorMs(env);
		this.heartbeatIntervalMs = Math.max(LOOP_LAG_TICK_MS, Math.floor(this.errorMs / HEARTBEAT_THRESHOLD_FRACTION));
		this.evidenceDir = ownGenerationDir(env);
	}

	start(): void {
		if (this.timer !== undefined) return;
		this.expectedTickAt = this.now() + LOOP_LAG_TICK_MS;
		this.activityMark = sessionActivityMark();
		const cpu = this.cpuUsage();
		this.cpuMicrosAtTick = cpu.user + cpu.system;
		this.heapBytesAtTick = this.heapUsed();
		// Unref'd: watching the loop must never be the reason the host stays alive.
		this.timer = setInterval(() => this.tick(), LOOP_LAG_TICK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
		this.expectedTickAt = undefined;
	}

	/**
	 * One measurement. Public so tests drive it on an injected clock instead of
	 * waiting for real drift. The first tick only establishes the baseline.
	 */
	tick(): void {
		const now = this.now();
		const expectedAt = this.expectedTickAt ?? now;
		const previousMark = this.activityMark;
		this.expectedTickAt = now + LOOP_LAG_TICK_MS;
		this.activityMark = sessionActivityMark();
		const cpu = this.cpuUsage();
		const cpuMicros = cpu.user + cpu.system;
		const heapBytes = this.heapUsed();
		const previousCpuMicros = this.cpuMicrosAtTick;
		const previousHeapBytes = this.heapBytesAtTick;
		this.cpuMicrosAtTick = cpuMicros;
		this.heapBytesAtTick = heapBytes;
		const driftMs = Math.round(now - expectedAt);
		recordLoopBlockedMs(driftMs);
		if (driftMs <= this.warnMs) {
			this.beat(now);
			return;
		}
		const attribution = sessionActivitySince(previousMark);
		const processCpuMs = Math.round((cpuMicros - previousCpuMicros) / 1000);
		const heapDeltaMb = Math.round((heapBytes - previousHeapBytes) / BYTES_PER_MB);
		if (driftMs > this.errorMs) {
			const record: RpcHostStalledEvent = {
				type: "host_stalled",
				driftMs,
				sessionId: attribution?.sessionId,
				tool: attribution?.tool,
				processCpuMs,
				heapDeltaMb,
			};
			this.emit(record);
			this.persistStall(now, record);
		}
		if (this.lastWarnAt !== undefined && now - this.lastWarnAt < LOOP_LAG_WARN_INTERVAL_MS) return;
		this.lastWarnAt = now;
		this.log(
			`senpi rpc host stall: event loop blocked ${driftMs}ms (${describeAttribution(attribution)}; ${describeWindow(processCpuMs, heapDeltaMb)})\n`,
		);
	}

	/**
	 * A healthy tick refreshes the heartbeat a reader takes as "this loop is running"; it stops the moment
	 * the loop does, which is how a stall in progress becomes visible (senpi#2566). Async and best-effort:
	 * the session loop never waits on it, and a write still in flight skips the next beat.
	 */
	private beat(now: number): void {
		if (!this.ownsEvidenceDir() || this.evidenceDir === undefined || this.heartbeatInFlight) return;
		if (this.lastHeartbeatAt !== undefined && now - this.lastHeartbeatAt < this.heartbeatIntervalMs) return;
		this.lastHeartbeatAt = now;
		this.heartbeatInFlight = true;
		void this.writeHeartbeat(this.evidenceDir, new Date(now).toISOString())
			.catch((cause: unknown) => this.evidenceFailed(cause))
			.finally(() => {
				this.heartbeatInFlight = false;
			});
	}

	private persistStall(now: number, record: RpcHostStalledEvent): void {
		if (!this.ownsEvidenceDir() || this.evidenceDir === undefined) return;
		void writeStallEvidence(this.evidenceDir, {
			at: new Date(now).toISOString(),
			driftMs: record.driftMs,
			processCpuMs: record.processCpuMs ?? 0,
			heapDeltaMb: record.heapDeltaMb ?? 0,
			...(record.sessionId ? { sessionId: record.sessionId } : {}),
			...(record.tool ? { tool: record.tool } : {}),
		}).catch((cause: unknown) => this.evidenceFailed(cause));
	}

	private ownsEvidenceDir(): boolean {
		return process.ppid === this.launchParentPid;
	}

	private evidenceFailed(cause: unknown): void {
		if (this.evidenceFailureLogged) return;
		this.evidenceFailureLogged = true;
		this.log(
			`senpi rpc host stall evidence not written: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
	}
}
