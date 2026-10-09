import { execFile } from "node:child_process";

const WINDOWS_FILETIME_EPOCH = 116444736000000000n;
export const PROCESS_START_TOLERANCE_MS = 3_000;

/** FILETIME and C/localized lstart/ISO identities share one millisecond representation. */
export function processStartTimeMs(identity: string): number | undefined {
	if (/^\d+$/.test(identity)) {
		const parsed = Number((BigInt(identity) - WINDOWS_FILETIME_EPOCH) / 10_000n);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	// Persisted lstart values, like the C-locale form, describe the host's local timezone.
	const localIdentity = identity.trim();
	const korean =
		/^(\d{4})\uB144\s+(\d{1,2})\uC6D4\s+(\d{1,2})\uC77C\s+[\uC6D4\uD654\uC218\uBAA9\uAE08\uD1A0\uC77C]\uC694\uC77C\s+(\d{1,2})\uC2DC\s+(\d{1,2})\uBD84\s+(\d{1,2})\uCD08$/.exec(
			localIdentity,
		);
	const japanese =
		/^[\u65E5\u6708\u706B\u6C34\u6728\u91D1\u571F](?:\u66DC\u65E5)?\s+(\d{1,2})\/\s*(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
			localIdentity,
		);
	const parts = korean
		? korean.slice(1)
		: japanese
			? [japanese[6], japanese[1], japanese[2], japanese[3], japanese[4], japanese[5]]
			: undefined;
	if (parts === undefined) {
		const parsed = Date.parse(identity);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	const [year = NaN, month = NaN, day = NaN, hour = NaN, minute = NaN, second = NaN] = parts.map(Number);
	const parsed = new Date(year, month - 1, day, hour, minute, second, 0);
	// A recognized but invalid calendar must not fall back to Date.parse's rollover behavior.
	return parsed.getFullYear() === year &&
		parsed.getMonth() === month - 1 &&
		parsed.getDate() === day &&
		parsed.getHours() === hour &&
		parsed.getMinutes() === minute &&
		parsed.getSeconds() === second
		? parsed.getTime()
		: undefined;
}

export function sameProcessStartMs(recorded: number | undefined, observed: number | undefined): boolean {
	return (
		recorded !== undefined &&
		observed !== undefined &&
		Number.isFinite(recorded) &&
		Number.isFinite(observed) &&
		Math.abs(recorded - observed) <= PROCESS_START_TOLERANCE_MS
	);
}

export interface DaemonPidFile {
	readonly pid: number;
	/**
	 * Identity guard for the recorded pid. `null` means the host was registered while its
	 * identity probe was starved: the pid is known, ownership is not provable, and no caller
	 * may signal it on that record.
	 */
	readonly processStartTime: string | null;
}

export function parseDaemonPidFile(text: string): DaemonPidFile | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error: unknown) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	const unguarded = parsed !== null && isRecord(parsed) && parsed.processStartTime === null;
	if (
		!isRecord(parsed) ||
		typeof parsed.pid !== "number" ||
		(!unguarded && typeof parsed.processStartTime !== "string")
	) {
		return undefined;
	}
	if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
	if (unguarded) return { pid: parsed.pid, processStartTime: null };
	if (typeof parsed.processStartTime !== "string" || parsed.processStartTime.trim() === "") return undefined;
	return { pid: parsed.pid, processStartTime: parsed.processStartTime };
}

export type ProcessIdentityResult =
	| { readonly kind: "present"; readonly identity: string }
	| { readonly kind: "absent" }
	| { readonly kind: "error"; readonly error: unknown };

/** Thrown when a live process refuses to yield an identity after the retry budget. */
export class ProcessIdentityUnreadableError extends Error {
	readonly pid: number;
	readonly attempts: number;
	override readonly cause: unknown;

	constructor(pid: number, attempts: number, cause: unknown) {
		super(
			`process identity for live pid ${pid} stayed unreadable after ${attempts} probe attempt(s): ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "ProcessIdentityUnreadableError";
		this.pid = pid;
		this.attempts = attempts;
		this.cause = cause;
	}
}

export interface IdentityProbeRetry {
	/** Probe attempts against a live pid before giving up (default 5). */
	readonly attempts?: number;
	/** Pause between attempts in ms (default 200). */
	readonly delayMs?: number;
}

/**
 * True when the pidfile still describes the running process. A probe FAILURE is not
 * an answer: on a pid that is no longer live it means "gone" (false); on a live pid it
 * is an observation gap — the platform query was starved or exited non-zero — so the
 * probe is retried within a bounded budget and only then surfaces as
 * ProcessIdentityUnreadableError. It never leaks the raw probe error as a verdict.
 */
export async function processMatchesPidFile(
	pidFile: DaemonPidFile,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
	isLive: (pid: number) => boolean = processIsLive,
	retry: IdentityProbeRetry = {},
): Promise<boolean> {
	// A record without an identity guard answers only the liveness half of the question: a pid
	// that is gone is gone, and a live one stays unknown so it is never claimed or signalled.
	if (pidFile.processStartTime === null) {
		if (!isLive(pidFile.pid)) return false;
		throw new ProcessIdentityUnreadableError(pidFile.pid, 0, new Error("pidfile carries no process identity guard"));
	}
	const attempts = Math.max(1, retry.attempts ?? 5);
	const delayMs = retry.delayMs ?? 200;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const current = await readStartTime(pidFile.pid);
			if (current !== undefined) {
				const recorded = processStartTimeMs(pidFile.processStartTime);
				const observed = processStartTimeMs(current);
				if (recorded !== undefined && observed !== undefined) return sameProcessStartMs(recorded, observed);
			}
			if (!isLive(pidFile.pid)) return false;
			lastError = new Error("process identity probe returned no usable identity for a live process");
			if (attempt < attempts) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		} catch (error: unknown) {
			if (!isLive(pidFile.pid)) return false;
			lastError = error;
			if (attempt < attempts) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
	throw new ProcessIdentityUnreadableError(pidFile.pid, attempts, lastError);
}

export async function readProcessIdentity(
	pid: number,
	platform: NodeJS.Platform = process.platform,
	timeoutMs?: number,
	isLive: (pid: number) => boolean = processIsLive,
	/** Owner records cross launch environments; legacy pidfiles keep their existing local-time format. */
	timeZone?: "UTC",
): Promise<ProcessIdentityResult> {
	const command =
		platform === "win32"
			? {
					executable: "powershell.exe",
					args: [
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`$process = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" -ErrorAction Stop; if ($null -eq $process) { Write-Output '__SENPI_ABSENT__'; exit 0 }; $process.CreationDate.ToFileTimeUtc().ToString("D", [Globalization.CultureInfo]::InvariantCulture)`,
					],
				}
			: { executable: "ps", args: ["-o", "lstart=", "-p", String(pid)] };
	return new Promise((resolve) => {
		const effectiveTimeoutMs = timeoutMs ?? (platform === "win32" ? 1_000 : undefined);
		execFile(
			command.executable,
			command.args,
			{
				windowsHide: true,
				...(effectiveTimeoutMs === undefined ? {} : { timeout: effectiveTimeoutMs }),
				...(platform === "win32" && timeZone === undefined
					? {}
					: { env: { ...process.env, LC_ALL: "C", LANG: "C", ...(timeZone ? { TZ: timeZone } : {}) } }),
			},
			(error, stdout) => {
				if (error) {
					const code = "code" in error ? error.code : undefined;
					// ps exits 1 for an unknown pid; on every platform a query that fails against a
					// pid that is no longer live has answered the question. Only a failure against a
					// LIVE pid is an observation error the caller must treat as unknown.
					if ((platform !== "win32" && code === 1) || !isLive(pid)) {
						resolve({ kind: "absent" });
						return;
					}
					resolve({ kind: "error", error });
					return;
				}
				const output = stdout.trim();
				if (output === "__SENPI_ABSENT__") return resolve({ kind: "absent" });
				if (!output || (platform === "win32" && !/^\d+$/.test(output)))
					return resolve({ kind: "error", error: new Error("invalid process identity output") });
				resolve({ kind: "present", identity: timeZone && platform !== "win32" ? `${output} UTC` : output });
			},
		).once("error", (error) => resolve({ kind: "error", error }));
	});
}

export async function stopValidatedPid(pidFile: DaemonPidFile, signal: NodeJS.Signals): Promise<void> {
	if (!(await processMatchesPidFile(pidFile))) return;
	try {
		process.kill(pidFile.pid, signal);
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ESRCH")) throw error;
	}
	if (signal === "SIGTERM") await waitForGone(pidFile, 10_000);
	if (signal === "SIGKILL") await waitForGone(pidFile, 2_000);
}

export async function waitForGone(pidFile: DaemonPidFile, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (!(await processMatchesPidFile(pidFile))) return true;
		await delay(100);
	}
	return !(await processMatchesPidFile(pidFile));
}

export async function readProcessStartTime(
	pid: number,
	platform: NodeJS.Platform = process.platform,
	timeoutMs?: number,
): Promise<string | undefined> {
	return readProcessIdentity(pid, platform, timeoutMs).then((result) => {
		if (result.kind === "error") throw result.error;
		return result.kind === "present" ? result.identity : undefined;
	});
}

export function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ESRCH")) return false;
		if (isNodeErrorCode(error, "EPERM")) return true;
		throw error;
	}
}

/**
 * Wait for a spawned pid's process identity.
 *
 * Returns `undefined` (UNKNOWN) when the budget is exhausted but the process is still alive:
 * budget exhaustion is an OBSERVABILITY failure, not evidence the child failed to start. On a
 * loaded Windows runner every `Get-CimInstance` probe can outlive `readProcessIdentity`'s 1s win32
 * default, so all ~9 attempts inside a 10s budget time out and throw while the process runs
 * normally (PR #1351/#1352 CI, runs 33839093178 / 33842155236). Only a pid that is really gone is
 * a startup failure, so callers can distinguish "no identity yet" from "child died".
 */
export async function waitForStartTime(
	pid: number,
	timeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
	isLive: (pid: number) => boolean = processIsLive,
): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		let startTime: string | undefined;
		try {
			startTime = await readStartTime(pid);
		} catch {
			// Process identity queries can fail transiently while a Windows process is
			// entering the CIM table. Keep the bounded startup wait alive so callers do
			// not mistake an observability failure for a child startup failure.
		}
		if (startTime) return startTime;
		await delay(20);
	}
	if (isLive(pid)) return undefined;
	throw new Error(`spawned daemon pid ${pid} had no process start time`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
