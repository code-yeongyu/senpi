/**
 * Which ledgered POSIX process groups a tool child's teardown may signal (senpi#3566, plan todo 4).
 *
 * The rule is senpi#3020's: a group the child created stays owned after its leader exits, for as long as it has
 * members, because orphaned descendants keep the group id. It is released, never signalled, when the leader pid is
 * alive but is no longer the recorded leader (the pid was reused), when the group is empty, or when it is the server's
 * own group. A `detached` entry is never swept; the command explicitly opted out of the child's lifetime.
 */
import { execFile } from "node:child_process";
import {
	processIsRunning,
	processStartTimeMs,
	readProcessStartTime,
	sameProcessStartMs,
} from "../../../utils/process-identity.ts";

export interface LedgeredGroup {
	readonly launchId: string;
	readonly pgid: number;
	/** The group leader's start identity as recorded at launch (`readProcessStartTime` form). */
	readonly leaderStart: string | undefined;
	readonly lifetime: "owned" | "detached";
}

export type GroupVerdict = "sweep" | "detached" | "empty" | "own-group" | "leader-reused";

export interface GroupProbes {
	readonly groupHasMembers: (pgid: number) => boolean;
	readonly isAlive: (pid: number) => boolean;
	readonly startOf: (pid: number) => Promise<string | undefined>;
	readonly ownGroup: () => Promise<number | undefined>;
	readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => void;
	readonly wait: (ms: number) => Promise<void>;
}

export async function classifyGroup(
	group: LedgeredGroup,
	ownGroup: number | undefined,
	probes: Pick<GroupProbes, "groupHasMembers" | "isAlive" | "startOf">,
): Promise<GroupVerdict> {
	if (group.lifetime === "detached") return "detached";
	// Without the server's own group nothing can be ruled out, so nothing is signalled.
	if (ownGroup === undefined || group.pgid === ownGroup || group.pgid <= 1) return "own-group";
	if (!probes.groupHasMembers(group.pgid)) return "empty";
	if (!probes.isAlive(group.pgid)) return "sweep";
	const observed = await probes.startOf(group.pgid).catch(() => undefined);
	const recorded = group.leaderStart === undefined ? undefined : processStartTimeMs(group.leaderStart);
	return sameProcessStartMs(recorded, observed === undefined ? undefined : processStartTimeMs(observed))
		? "sweep"
		: "leader-reused";
}

export interface SweepOutcome {
	readonly launchId: string;
	readonly pgid: number;
	readonly verdict: GroupVerdict;
	readonly survived?: boolean;
}

export async function sweepGroups(
	groups: readonly LedgeredGroup[],
	options: { readonly graceMs: number; readonly killWaitMs: number; readonly pollMs?: number },
	probes: GroupProbes = defaultGroupProbes,
): Promise<SweepOutcome[]> {
	const ownGroup = await probes.ownGroup();
	const verdicts = await Promise.all(
		groups.map(async (group) => ({ group, verdict: await classifyGroup(group, ownGroup, probes) })),
	);
	const targets = verdicts.filter((entry) => entry.verdict === "sweep").map((entry) => entry.group.pgid);
	for (const pgid of targets) probes.signalGroup(pgid, "SIGTERM");
	let remaining = await drain(targets, options.graceMs, options.pollMs ?? 25, probes);
	for (const pgid of remaining) probes.signalGroup(pgid, "SIGKILL");
	remaining = await drain(remaining, options.killWaitMs, options.pollMs ?? 25, probes);
	return verdicts.map(({ group, verdict }) => ({
		launchId: group.launchId,
		pgid: group.pgid,
		verdict,
		...(verdict === "sweep" ? { survived: remaining.includes(group.pgid) } : {}),
	}));
}

async function drain(
	pgids: readonly number[],
	budgetMs: number,
	pollMs: number,
	probes: GroupProbes,
): Promise<number[]> {
	let remaining = pgids.filter((pgid) => probes.groupHasMembers(pgid));
	for (let waited = 0; remaining.length > 0 && waited < budgetMs; waited += pollMs) {
		await probes.wait(pollMs);
		remaining = remaining.filter((pgid) => probes.groupHasMembers(pgid));
	}
	return remaining;
}

function processGroupOf(pid: number): Promise<number | undefined> {
	if (process.platform === "win32") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 2_000 }, (error, stdout) => {
			const text = String(stdout).trim();
			resolve(error === null && /^\d+$/u.test(text) ? Number(text) : undefined);
		});
	});
}

function groupHasMembers(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

export const defaultGroupProbes: GroupProbes = {
	groupHasMembers,
	// An exited, unreaped leader (state Z) has no start identity left to compare, so it must read as exited:
	// its orphaned members keep the group, and the group is swept (senpi#3020, senpi#4119).
	isAlive: processIsRunning,
	startOf: (pid) => readProcessStartTime(pid),
	ownGroup: () => processGroupOf(process.pid),
	signalGroup: (pgid, signal) => {
		try {
			process.kill(-pgid, signal);
		} catch {
			// The group emptied between the membership check and the signal.
		}
	},
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
