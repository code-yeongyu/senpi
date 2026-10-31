import type { GroupProbes } from "./group-ownership.ts";
import type { HeldManagedLaunch, ManagedCommand } from "./managed-launch-process.ts";
import { MANAGED_LAUNCH_MARKER_ENV, type TreeProbes } from "./managed-tree.ts";
import { JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, type Kernel32Job } from "./windows-job.ts";

const START = "Mon Oct 19 00:00:00 2026";

interface FakeProcess {
	alive: boolean;
	/** Outermost first: the last entry is the immediate job. */
	jobs: Set<number>;
	group: number;
	readonly ppid: number;
	readonly marker: string | undefined;
	immortal?: boolean;
}

/**
 * Independent OS model: inheritance copies memberships, the environment marker and the group; `setsid` starts a new
 * group; terminating a job/group kills all its members. Explicit breakaway follows Microsoft's nested-job rule: it fails
 * (ERROR_ACCESS_DENIED) when the immediate job does not permit breakaway, and otherwise leaves every job up the chain
 * until one that does not permit it.
 */
export function managedLaunchFixture() {
	let nextPid = 100;
	let nextJob = 0;
	const processes = new Map<number, FakeProcess>();
	const jobs = new Map<number, { flags: number; parent?: number }>();
	const launches: Array<{
		readonly shim: number;
		target?: number;
		descendant?: number;
		setsidDescendant?: number;
		/** The child an explicit `CREATE_BREAKAWAY_FROM_JOB` request produced; `undefined` when Windows refused it. */
		breakaway?: number;
		readonly finish: (code: number) => void;
	}> = [];
	const spawn = (parent?: number, options: { setsid?: boolean; marker?: string } = {}): number => {
		const pid = ++nextPid;
		const inherited = parent === undefined ? undefined : processes.get(parent);
		processes.set(pid, {
			alive: true,
			jobs: new Set(inherited?.jobs),
			group: options.setsid === true ? pid : (inherited?.group ?? pid),
			ppid: parent ?? 1,
			marker: options.marker ?? inherited?.marker,
		});
		return pid;
	};
	const spawnBreakaway = (parent: number): number | undefined => {
		const chain = [...(processes.get(parent)?.jobs ?? [])];
		const permits = (job: number | undefined) =>
			job !== undefined && ((jobs.get(job)?.flags ?? 0) & JOB_OBJECT_LIMIT_BREAKAWAY_OK) !== 0;
		if (chain.length > 0 && !permits(chain.at(-1))) return undefined;
		while (chain.length > 0 && permits(chain.at(-1))) chain.pop();
		const pid = spawn(parent);
		const child = processes.get(pid);
		if (child !== undefined) child.jobs = new Set(chain);
		return pid;
	};
	const kill = (matches: (p: FakeProcess) => boolean): void => {
		for (const process of processes.values())
			if (matches(process) && process.immortal !== true) process.alive = false;
	};
	const kernel: Kernel32Job = {
		CreateJobObjectW: () => {
			const handle = ++nextJob;
			jobs.set(handle, { flags: 0 });
			return handle;
		},
		SetInformationJobObject: (handle, _class, info) => {
			const job = jobs.get(Number(handle));
			if (job === undefined) return 0;
			job.flags = new DataView(info.buffer).getUint32(16, true);
			return 1;
		},
		OpenProcess: (_access, _inherit, pid) => `process:${pid}`,
		AssignProcessToJobObject: (handle, processHandle) => {
			const process = processes.get(Number(String(processHandle).slice(8)));
			const id = Number(handle);
			const job = jobs.get(id);
			if (process === undefined || job === undefined || !process.alive) return 0;
			const parent = [...process.jobs].at(-1);
			if (job.parent !== undefined && job.parent !== parent) return 0;
			if (parent !== undefined) job.parent = parent;
			process.jobs.add(id);
			return 1;
		},
		IsProcessInJob: (processHandle, job, result) => {
			const process = processes.get(Number(String(processHandle).slice(8)));
			new DataView(result.buffer).setUint32(0, process?.jobs.has(Number(job)) ? 1 : 0, true);
			return 1;
		},
		QueryInformationJobObject: (handle, _class, result) => {
			const pids = [...processes].filter(([, p]) => p.alive && p.jobs.has(Number(handle))).map(([pid]) => pid);
			const view = new DataView(result.buffer);
			view.setUint32(0, pids.length, true);
			view.setUint32(4, pids.length, true);
			pids.forEach((pid, index) => view.setBigUint64(8 + index * 8, BigInt(pid), true));
			return 1;
		},
		TerminateJobObject: (handle) => {
			kill((p) => p.jobs.has(Number(handle)));
			return 1;
		},
		CloseHandle: (handle) => {
			if (typeof handle === "number") {
				const job = jobs.get(handle);
				if (job !== undefined && (job.flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) !== 0)
					kill((p) => p.jobs.has(handle));
				jobs.delete(handle);
			}
			return 1;
		},
		GetLastError: () => 5,
		GetCurrentProcess: () => "process:1",
	};
	const wait = async (): Promise<void> => {
		throw new Error("The fake OS terminates synchronously; polling would hide a broken stop.");
	};
	const groups: GroupProbes = {
		groupHasMembers: (group) => [...processes.values()].some((p) => p.alive && p.group === group),
		isAlive: (pid) => processes.get(pid)?.alive === true,
		startOf: async () => START,
		ownGroup: async () => 1,
		signalGroup: (group) => kill((p) => p.group === group),
		wait,
	};
	const tree: TreeProbes = {
		scan: async () =>
			[...processes]
				.filter(([, p]) => p.alive)
				.map(([pid, p]) => ({
					pid,
					ppid: p.ppid,
					pgid: p.group,
					zombie: false,
					start: START,
					markers: p.marker === undefined ? [] : [p.marker],
				})),
		signal: (pid) => kill((p) => p === processes.get(pid)),
		wait,
	};
	const prepare = async (command: ManagedCommand): Promise<HeldManagedLaunch> => {
		const shim = spawn();
		const completed = Promise.withResolvers<number>();
		const record: (typeof launches)[number] = { shim, finish: completed.resolve };
		launches.push(record);
		return {
			pid: shim,
			completed: completed.promise,
			release: async () => {
				const target = spawn(shim, { marker: command.env[MANAGED_LAUNCH_MARKER_ENV] });
				record.target = target;
				record.descendant = spawn(target);
				record.setsidDescendant = spawn(target, { setsid: true });
				record.breakaway = spawnBreakaway(target);
				return target;
			},
			close: async () => {
				const process = processes.get(shim);
				if (process !== undefined) process.alive = false;
			},
		};
	};
	return {
		kernel,
		groups,
		tree,
		prepare,
		launches,
		processes,
		jobs,
		alive: (pid: number | undefined) => pid !== undefined && processes.get(pid)?.alive === true,
		exit: (pid: number | undefined) => {
			const process = pid === undefined ? undefined : processes.get(pid);
			if (process !== undefined) process.alive = false;
		},
	};
}
