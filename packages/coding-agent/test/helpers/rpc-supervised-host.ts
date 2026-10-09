/**
 * Real lifecycle supervisors around a light host child (`fixtures/rpc-supervised-child.ts`), for the
 * suites that stop, stall and kill hosts and then read what was recorded. POSIX only: the scenarios
 * rely on SIGSTOP/SIGCONT and on the process table.
 */
import { execFileSync } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { VERSION } from "../../src/config.ts";
import { type HostCrashRecord, readHostCrashRecords } from "../../src/modes/rpc/host-crash-record.ts";
import { readHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "../../src/modes/rpc/host-decision.ts";
import { createHostDaemonPaths, type EnsureHostOptions, ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { processAlive, reapProcessesUnder, waitForPidGone } from "./spawned-host-reaper.ts";

export const SUPERVISED_CAPABILITIES = `multi_session,extension_events,session_context,session_kind,${GENERATION_HANDOFF_CAPABILITY}`;
const childFixture = join(import.meta.dirname, "..", "fixtures", "rpc-supervised-child.ts");
const supervisorEntry = join(import.meta.dirname, "..", "..", "src", "modes", "rpc", "host-lifecycle.ts");

export interface SupervisedScratch {
	readonly root: string;
	readonly agentDir: string;
	readonly socket: string;
}

const roots: string[] = [];
/** Host children live under the OS temp dir, not the scratch root, so they are reaped by pid. */
const observedChildren = new Set<number>();

export async function supervisedScratch(label: string): Promise<SupervisedScratch> {
	const root = await mkdtemp(join(tmpdir(), `senpi-stop-${label}-`));
	roots.push(root);
	return { root, agentDir: join(root, "agent"), socket: join(root, "rpc.sock") };
}

export async function removeSupervisedScratches(): Promise<void> {
	for (const pid of observedChildren) {
		if (processAlive(pid)) process.kill(pid, "SIGKILL");
	}
	observedChildren.clear();
	for (const root of roots.splice(0)) {
		await reapProcessesUnder(root);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

export function supervisedDaemonPaths(qa: SupervisedScratch) {
	return createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
}

/** The supervisor argv a spawn hook launches: the real supervisor, its child replaced by the fixture. */
export function supervisorLaunch(behavior: "answer" | "silent" = "answer") {
	return (args: readonly string[]) => ({
		command: process.execPath,
		args: [
			supervisorEntry,
			...args,
			"--child-command",
			process.execPath,
			"--child-args",
			JSON.stringify([childFixture, VERSION, SUPERVISED_CAPABILITIES, behavior]),
		],
	});
}

export type SupervisedTestOptions = NonNullable<EnsureHostOptions["_test"]>;

export function ensureSupervised(
	qa: SupervisedScratch,
	options: { env?: Record<string, string>; behavior?: "answer" | "silent"; test?: SupervisedTestOptions } = {},
) {
	return ensureHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		env: { PI_OFFLINE: "1", PI_TELEMETRY: "0", ...options.env },
		_test: { launch: supervisorLaunch(options.behavior), ...options.test },
	});
}

export async function registeredSupervisor(qa: SupervisedScratch): Promise<{ pid: number; instanceId: string }> {
	const registered = await readHostRegistration(supervisedDaemonPaths(qa));
	if (registered === undefined) throw new Error("no registered supervisor");
	return { pid: registered.record.pid, instanceId: registered.instanceId };
}

/**
 * The supervisor's HOST child, matched by its command line: the supervisor also runs short-lived
 * helpers of its own (`ps -o lstart=` for its and its child's start time), and the first child
 * `pgrep -P` lists can be one of those, which exits at once and would stand in for the host.
 */
export function hostChildOf(supervisorPid: number): number {
	const output = execFileSync("pgrep", ["-P", String(supervisorPid), "-f", basename(childFixture)], {
		encoding: "utf8",
	});
	const pid = Number(output.split("\n")[0]?.trim());
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`supervisor ${supervisorPid} has no host child`);
	observedChildren.add(pid);
	return pid;
}

export async function expectGoneWithin(pid: number, timeoutMs: number): Promise<void> {
	if (!(await waitForPidGone(pid, timeoutMs))) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

export function crashRecords(qa: SupervisedScratch): readonly HostCrashRecord[] {
	return readHostCrashRecords(supervisedDaemonPaths(qa).dir);
}

/** Terminal records: everything but the host child's own watchdog line. */
export function terminalRecords(qa: SupervisedScratch, generation: string): readonly HostCrashRecord[] {
	return crashRecords(qa).filter((record) => record.kind !== "rpc-host-watchdog" && record.generation === generation);
}

export function watchdogRecords(qa: SupervisedScratch, generation: string): readonly HostCrashRecord[] {
	return crashRecords(qa).filter((record) => record.kind === "rpc-host-watchdog" && record.generation === generation);
}

/** The instance id the ensure chose for the start in flight, read from the boot settings it wrote. */
export async function bootInstanceId(qa: SupervisedScratch): Promise<string> {
	const settings: unknown = JSON.parse(await readFile(supervisedDaemonPaths(qa).settingsFile, "utf8"));
	const instanceId =
		typeof settings === "object" && settings !== null ? Reflect.get(settings, "instanceId") : undefined;
	if (typeof instanceId !== "string") throw new Error("boot settings name no instance id");
	return instanceId;
}

/** `generations/<instanceId>/` of the supervised endpoint, where per-generation evidence lives. */
export function generationDir(qa: SupervisedScratch, instanceId: string): string {
	return join(supervisedDaemonPaths(qa).generationsDir, instanceId);
}

/** Writes one per-generation evidence file the way the host would (JSON, one line). */
export async function writeGenerationFile(
	qa: SupervisedScratch,
	instanceId: string,
	name: string,
	content: unknown,
): Promise<void> {
	await writeFile(join(generationDir(qa, instanceId), name), `${JSON.stringify(content)}\n`, { mode: 0o600 });
}

/** Resolves once `path` exists, by stat polling (never `fs.watch`); rejects after `timeoutMs`. */
export function fileAppears(path: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unwatchFile(path, onChange);
			reject(new Error(`${path} did not appear within ${timeoutMs}ms`));
		}, timeoutMs);
		const onChange = (current: { readonly nlink: number }): void => {
			if (current.nlink === 0) return;
			clearTimeout(timer);
			unwatchFile(path, onChange);
			resolve();
		};
		watchFile(path, { interval: 25 }, onChange);
	});
}

export { processAlive };
