import { execFile } from "node:child_process";

export interface DaemonPidFile {
	readonly pid: number;
	readonly processStartTime: string;
}

export function parseDaemonPidFile(text: string): DaemonPidFile | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error: unknown) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (!isRecord(parsed) || typeof parsed.pid !== "number" || typeof parsed.processStartTime !== "string") {
		return undefined;
	}
	if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || parsed.processStartTime.trim() === "") {
		return undefined;
	}
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
	const attempts = Math.max(1, retry.attempts ?? 5);
	const delayMs = retry.delayMs ?? 200;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const current = await readStartTime(pidFile.pid);
			return current === pidFile.processStartTime;
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
			{ windowsHide: true, ...(effectiveTimeoutMs === undefined ? {} : { timeout: effectiveTimeoutMs }) },
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
				resolve({ kind: "present", identity: output });
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
