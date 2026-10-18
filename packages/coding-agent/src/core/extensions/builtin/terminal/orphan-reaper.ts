import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { type ChildProcessIdentity, processBootAtMs, sameBoot } from "./process-identity.ts";
import { readProcessStartMs } from "./process-start-probe.ts";

export type OwnerVerdict = "confirmed" | "dead" | "unverifiable";

export interface ProcessEvidence {
	readonly startedAtMs?: number;
	/** The command line the OS reports for the pid, space-joined. */
	readonly argv?: string;
	/** Linux only: raw NUL-separated `/proc/<pid>/environ`. */
	readonly environ?: string;
}

export interface OwnerProbes {
	readonly platform?: NodeJS.Platform;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly readProcessEvidence?: (pid: number) => Promise<ProcessEvidence | undefined>;
	readonly bootAtMs?: () => number;
}

export interface KillTreeOptions {
	readonly graceMs?: number;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
	readonly wait?: (ms: number) => Promise<void>;
}

export interface ReapResult {
	readonly action: "killed" | "already-dead" | "none";
	readonly reason?: string;
}

/** Start instants further apart than this are different processes, even on the same pid. */
export const OWNER_START_TOLERANCE_MS = 2_000;
export const DEFAULT_KILL_GRACE_MS = 1_000;
/** `ps -o lstart=` is always `Www Mmm dd hh:mm:ss yyyy`; the command follows. */
const LSTART_LENGTH = 24;

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the pid exists but belongs to someone else - alive, and certainly not ours to kill.
		return errorCode(error) !== "ESRCH";
	}
}

function execText(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const env = { ...process.env, LC_ALL: "C" };
		execFile(command, [...args], { encoding: "utf8", timeout: 5_000, windowsHide: true, env }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

async function readLinuxEvidence(pid: number): Promise<ProcessEvidence> {
	const [startedAtMs, environ, cmdline] = await Promise.all([
		readProcessStartMs(pid),
		readFile(`/proc/${pid}/environ`, "utf8"),
		readFile(`/proc/${pid}/cmdline`, "utf8"),
	]);
	return { startedAtMs, environ, argv: cmdline.split("\0").filter(Boolean).join(" ") };
}

async function readDarwinEvidence(pid: number): Promise<ProcessEvidence | undefined> {
	const text = (await execText("ps", ["-o", "lstart=,command=", "-p", String(pid)])).trim();
	if (text.length <= LSTART_LENGTH) return undefined;
	return { startedAtMs: new Date(text.slice(0, LSTART_LENGTH)).getTime(), argv: text.slice(LSTART_LENGTH).trim() };
}

async function readWindowsEvidence(pid: number): Promise<ProcessEvidence | undefined> {
	const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { $_.CreationDate.ToUniversalTime().ToString('o') + '|' + $_.CommandLine }`;
	const text = (await execText("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])).trim();
	const separator = text.indexOf("|");
	if (separator < 0) return undefined;
	return { startedAtMs: new Date(text.slice(0, separator)).getTime(), argv: text.slice(separator + 1).trim() };
}

function defaultEvidenceReader(platform: NodeJS.Platform): (pid: number) => Promise<ProcessEvidence | undefined> {
	if (platform === "linux") return readLinuxEvidence;
	if (platform === "darwin") return readDarwinEvidence;
	if (platform === "win32") return readWindowsEvidence;
	return async () => undefined;
}

function argvMatches(observed: string | undefined, argv: readonly string[]): boolean {
	if (observed === undefined || argv.length === 0) return false;
	const command = argv[argv.length - 1] ?? "";
	return observed.trim() === argv.join(" ") || (command.length > 0 && observed.includes(command));
}

/**
 * A pid alone is never trusted: after a crash or reboot the OS recycles it, so killing on a bare
 * pid match can take down an unrelated process. Ownership needs the pid alive on the same boot,
 * the same start instant, and a per-platform content marker (env on Linux, argv elsewhere). A
 * background session carries no monitor id in its environment, so it is matched by argv everywhere.
 */
export async function confirmOwner(
	runtime: ChildProcessIdentity,
	monitorId: string | undefined,
	probes: OwnerProbes = {},
): Promise<OwnerVerdict> {
	const platform = probes.platform ?? process.platform;
	try {
		if (!sameBoot(runtime.bootAtMs, (probes.bootAtMs ?? processBootAtMs)())) return "dead";
		if (!(probes.isProcessAlive ?? isProcessAlive)(runtime.pid)) return "dead";
		const evidence = await (probes.readProcessEvidence ?? defaultEvidenceReader(platform))(runtime.pid);
		if (evidence?.startedAtMs === undefined || !Number.isFinite(evidence.startedAtMs)) return "unverifiable";
		if (Math.abs(evidence.startedAtMs - runtime.startedAtMs) > OWNER_START_TOLERANCE_MS) return "unverifiable";
		const marked =
			platform === "linux" && monitorId !== undefined
				? (evidence.environ ?? "").split("\0").includes(`SENPI_MONITOR_ID=${monitorId}`)
				: argvMatches(evidence.argv, runtime.argv);
		return marked ? "confirmed" : "unverifiable";
	} catch {
		return "unverifiable";
	}
}

export async function killTree(
	runtime: ChildProcessIdentity,
	options: KillTreeOptions = {},
): Promise<{ action: "killed" | "already-dead" }> {
	const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
	const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const target = runtime.processGroupId !== undefined ? -runtime.processGroupId : runtime.pid;
	try {
		kill(target, "SIGTERM");
	} catch (error) {
		if (errorCode(error) === "ESRCH") return { action: "already-dead" };
		throw error;
	}
	await wait(options.graceMs ?? DEFAULT_KILL_GRACE_MS);
	if ((options.isProcessAlive ?? isProcessAlive)(runtime.pid)) {
		try {
			kill(target, "SIGKILL");
		} catch (error) {
			if (errorCode(error) !== "ESRCH") throw error;
		}
	}
	return { action: "killed" };
}

export async function reapBeforeRespawn(
	runtime: ChildProcessIdentity,
	monitorId: string,
	probes: OwnerProbes & KillTreeOptions = {},
): Promise<ReapResult> {
	const verdict = await confirmOwner(runtime, monitorId, probes);
	if (verdict === "dead") return { action: "none" };
	// win32 has no process groups to signal and no race-free way to act on a confirmation, so it only reports.
	if (verdict === "confirmed" && (probes.platform ?? process.platform) !== "win32") return killTree(runtime, probes);
	return { action: "none", reason: `previous watcher pid ${runtime.pid} unverifiable` };
}
