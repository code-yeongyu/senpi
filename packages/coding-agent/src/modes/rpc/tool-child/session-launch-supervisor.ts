/**
 * Session ownership for explicit managed commands (senpi#4230). This is outside disposable tool-child generations.
 * Raw cp/Bun/PTY launches are NOT migrated: they still use their existing generation containment.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DescendantsLedger } from "./descendants.ts";
import { defaultGroupProbes, type GroupProbes, type LedgeredGroup, sweepGroups } from "./group-ownership.ts";
import { type HeldManagedLaunch, type ManagedCommand, prepareManagedLaunch } from "./managed-launch-process.ts";
import {
	defaultTreeProbes,
	MANAGED_LAUNCH_MARKER_ENV,
	selectTree,
	sweepTree,
	type TreeProbes,
} from "./managed-tree.ts";
import { type Kernel32Job, loadKernel32Job, MANAGED_LAUNCH_JOB_LIMITS, WindowsJob } from "./windows-job.ts";

export class ManagedLaunchError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "ManagedLaunchError";
		this.code = code;
	}
}

export interface ManagedLaunch {
	readonly id: string;
	readonly pid: number;
	/** Settles after the command exits and, when nothing it started is still running, after the launch is reaped. */
	readonly completed: Promise<number>;
}

interface LaunchOwner {
	readonly id: string;
	readonly callId: string;
	readonly held: HeldManagedLaunch;
	readonly job: WindowsJob | undefined;
	readonly group: LedgeredGroup;
	/** POSIX: the environment marker every descendant inherits, so one in its own session is still found. */
	readonly marker: string | undefined;
	finished: boolean;
	stopping?: Promise<void>;
}

/** One start in progress. A cancel reaches the starts in progress and the launches it finds, never a later start. */
interface Admission {
	readonly callId: string;
	cancelled: boolean;
}

export interface SessionLaunchOptions {
	readonly dir: string;
	readonly platform?: NodeJS.Platform;
	readonly kernel?: Kernel32Job;
	readonly groups?: GroupProbes;
	readonly tree?: TreeProbes;
	readonly prepare?: (command: ManagedCommand) => Promise<HeldManagedLaunch>;
}

const STOP_BUDGET = { graceMs: 2_000, killWaitMs: 2_000 } as const;

export class SessionLaunchSupervisor {
	readonly #options: SessionLaunchOptions;
	readonly #ledger: DescendantsLedger;
	readonly #launches = new Map<string, LaunchOwner>();
	readonly #starting = new Set<Promise<ManagedLaunch>>();
	readonly #admissions = new Set<Admission>();
	readonly #groups: GroupProbes;
	readonly #tree: TreeProbes;
	readonly #platform: NodeJS.Platform;
	#sessionJob: WindowsJob | undefined;
	#kernel: Kernel32Job | undefined;
	#next = 0;
	#closed = false;
	#closing: Promise<void> | undefined;

	constructor(options: SessionLaunchOptions) {
		this.#options = options;
		this.#ledger = new DescendantsLedger(join(options.dir, "managed-launches.ledger"));
		this.#groups = options.groups ?? defaultGroupProbes;
		this.#tree = options.tree ?? defaultTreeProbes;
		this.#platform = options.platform ?? process.platform;
	}

	start(command: ManagedCommand, callId: string): Promise<ManagedLaunch> {
		if (this.#closed)
			return Promise.reject(new ManagedLaunchError("managed_session_closed", "the session has ended"));
		const admission: Admission = { callId, cancelled: false };
		this.#admissions.add(admission);
		void this.#reapFinished();
		const pending = this.#start(command, admission);
		this.#starting.add(pending);
		void pending.then(
			() => this.#settled(pending, admission),
			() => this.#settled(pending, admission),
		);
		return pending;
	}

	#settled(pending: Promise<ManagedLaunch>, admission: Admission): void {
		this.#starting.delete(pending);
		this.#admissions.delete(admission);
	}

	async #start(command: ManagedCommand, admission: Admission): Promise<ManagedLaunch> {
		const id = `managed-${++this.#next}`;
		const marker = this.#platform === "win32" ? undefined : randomUUID();
		const marked =
			marker === undefined ? command : { ...command, env: { ...command.env, [MANAGED_LAUNCH_MARKER_ENV]: marker } };
		const held = await (this.#options.prepare ?? prepareManagedLaunch)(marked);
		let job: WindowsJob | undefined;
		let owner: LaunchOwner | undefined;
		try {
			this.#checkAdmission(admission);
			if (this.#platform === "win32") {
				this.#kernel ??= this.#options.kernel ?? loadKernel32Job();
				if (this.#kernel === undefined)
					throw new ManagedLaunchError("managed_launch_unsupported", "Windows managed launches require bun:ffi");
				// Neither job permits breakaway: one that did would let a member leave it and every job above it.
				this.#sessionJob ??= WindowsJob.create(this.#kernel, MANAGED_LAUNCH_JOB_LIMITS);
				this.#sessionJob.assign(held.pid);
				job = WindowsJob.create(this.#kernel, MANAGED_LAUNCH_JOB_LIMITS);
				job.assign(held.pid);
			}
			const leaderStart = this.#platform === "win32" ? undefined : await this.#groups.startOf(held.pid);
			const group: LedgeredGroup = { launchId: id, pgid: held.pid, leaderStart, lifetime: "owned" };
			owner = { id, callId: admission.callId, held, job, group, marker, finished: false };
			this.#launches.set(id, owner);
			await this.#ledger.append({
				launchId: id,
				generation: 0,
				origin: "tool",
				api: "cp.spawn",
				containment: this.#platform === "win32" ? "job" : "own-group",
				lifetime: "owned",
				pid: held.pid,
				pgid: held.pid,
				...(leaderStart === undefined ? {} : { leaderStart }),
				atMs: Date.now(),
			});
			this.#checkAdmission(admission);
			const pid = await held.release();
			this.#checkAdmission(admission);
			// Completion releases the caller's waiter, not the ownership of remaining descendants.
			const launched = owner;
			const completed = held.completed.then(async (code) => {
				launched.finished = true;
				await this.#reapIfDone(launched).catch(() => undefined);
				return code;
			});
			return { id, pid, completed };
		} catch (error) {
			if (owner !== undefined) await this.#stop(owner);
			else {
				job?.terminate();
				job?.close();
				await held.close();
			}
			throw error;
		}
	}

	#checkAdmission(admission: Admission): void {
		if (this.#closed) throw new ManagedLaunchError("managed_session_closed", "the session has ended");
		if (admission.cancelled)
			throw new ManagedLaunchError("managed_launch_cancelled", "the owning call was cancelled");
	}

	/** A service uses its own owner key, not the id of a client call that happens to use it. */
	async cancel(callId: string): Promise<void> {
		for (const admission of this.#admissions) if (admission.callId === callId) admission.cancelled = true;
		await Promise.all(
			[...this.#launches.values()].filter((entry) => entry.callId === callId).map((entry) => this.#stop(entry)),
		);
	}

	async stop(id: string): Promise<void> {
		const entry = this.#launches.get(id);
		if (entry !== undefined) await this.#stop(entry);
	}

	async #reapFinished(): Promise<void> {
		const finished = [...this.#launches.values()].filter((entry) => entry.finished);
		await Promise.all(finished.map((entry) => this.#reapIfDone(entry).catch(() => undefined)));
	}

	async #reapIfDone(entry: LaunchOwner): Promise<void> {
		if (entry.stopping !== undefined || !this.#launches.has(entry.id)) return;
		if (entry.job !== undefined) {
			const members = entry.job.activeMembers();
			if (members === undefined || members.some((pid) => pid !== entry.held.pid)) return;
		} else {
			const rows = await this.#tree.scan();
			if (rows === undefined) return;
			const root = { marker: entry.marker, leader: { pid: entry.held.pid, start: entry.group.leaderStart } };
			if ([...selectTree(rows, root).keys()].some((pid) => pid !== entry.held.pid)) return;
		}
		await this.#stop(entry);
	}

	#stop(entry: LaunchOwner): Promise<void> {
		if (entry.stopping !== undefined) return entry.stopping;
		const stopping = (async () => {
			if (entry.job !== undefined) {
				entry.job.terminate();
				entry.job.close();
			} else {
				// The tree first: its snapshot must see each setsid descendant's parent before the group is signalled.
				const root = { marker: entry.marker, leader: { pid: entry.held.pid, start: entry.group.leaderStart } };
				const tree = await sweepTree(root, STOP_BUDGET, this.#tree);
				const outcomes = await sweepGroups([entry.group], STOP_BUDGET, this.#groups);
				if ((tree?.length ?? 0) > 0 || outcomes.some((outcome) => outcome.survived === true))
					throw new ManagedLaunchError("managed_launch_stop_failed", `${entry.id} still has running members`);
			}
			await entry.held.close();
			this.#launches.delete(entry.id);
		})();
		entry.stopping = stopping;
		// A failed stop leaves the launch owned, and a later stop or close tries again.
		void stopping.catch(() => {
			if (entry.stopping === stopping) delete entry.stopping;
		});
		return stopping;
	}

	close(): Promise<void> {
		this.#closed = true;
		if (this.#closing !== undefined) return this.#closing;
		const closing = (async () => {
			try {
				// Stop admitted starts before joining them: their startup acknowledgement may still be pending.
				await Promise.all([...this.#launches.values()].map((entry) => this.#stop(entry)));
				await Promise.allSettled([...this.#starting]);
				await Promise.all([...this.#launches.values()].map((entry) => this.#stop(entry)));
				await this.#ledger.remove();
			} finally {
				this.#sessionJob?.terminate();
				this.#sessionJob?.close();
			}
		})();
		this.#closing = closing;
		void closing.catch(() => {
			if (this.#closing === closing) this.#closing = undefined;
		});
		return closing;
	}
}
