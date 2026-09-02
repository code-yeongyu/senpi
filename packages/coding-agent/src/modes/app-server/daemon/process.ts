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

export async function processMatchesPidFile(
	pidFile: DaemonPidFile,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<boolean> {
	const current = await readStartTime(pidFile.pid);
	return current === pidFile.processStartTime;
}

export async function readProcessIdentity(
	pid: number,
	platform: NodeJS.Platform = process.platform,
	timeoutMs?: number,
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
					resolve(platform !== "win32" && code === 1 ? { kind: "absent" } : { kind: "error", error });
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

export async function waitForStartTime(
	pid: number,
	timeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<string> {
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
