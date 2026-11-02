/**
 * Real lifecycle supervisors around a light host child (`fixtures/rpc-supervised-child.ts`), for the
 * suites that stop, stall and kill hosts and then read what was recorded. POSIX only: the scenarios
 * rely on SIGSTOP/SIGCONT and on the process table.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

export async function ensureSupervised(
	qa: SupervisedScratch,
	options: { env?: Record<string, string>; behavior?: "answer" | "silent"; test?: SupervisedTestOptions } = {},
) {
	const controller = new AbortController();
	let advertised: Promise<void> | undefined;
	try {
		const ensured = await ensureHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			env: { PI_OFFLINE: "1", PI_TELEMETRY: "0", ...options.env },
			_test: {
				...options.test,
				launch: (args) => {
					// Settings created this generation directory BEFORE spawn. Socket readiness alone
					// precedes acceptRequests: arm here, then keep callers from stopping startup early.
					const settings: { instanceId: string } = JSON.parse(
						readFileSync(supervisedDaemonPaths(qa).settingsFile, "utf8"),
					);
					advertised = fileAppears(
						join(generationDir(qa, settings.instanceId), "drain-watch.json"),
						10_000,
						controller.signal,
					);
					// A failed ensure cancels this wait; observe its rejection even before readiness returns.
					void advertised.catch(() => {});
					return (options.test?.launch ?? supervisorLaunch(options.behavior))(args);
				},
			},
		});
		try {
			await advertised;
			return ensured;
		} catch (cause) {
			ensured.release();
			throw cause;
		}
	} finally {
		controller.abort();
	}
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

/** Subscribe before the initial stat: both an existing file and a later atomic rename satisfy the wait. */
export async function fileAppears(path: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const watcher = watch(dirname(path));
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`${path} did not appear within ${timeoutMs}ms`)), timeoutMs);
			const check = async () => {
				try {
					await stat(path);
					resolve();
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code !== "ENOENT") reject(cause);
				}
			};
			watcher.on("change", (_event, changed) => {
				if (changed === null || changed === basename(path)) void check();
			});
			watcher.once("error", reject);
			onAbort = () => reject(signal?.reason);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			else void check();
		});
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		watcher.close();
	}
}

export { processAlive };
