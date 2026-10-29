import { existsSync, type FSWatcher, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHostDaemonPaths, type HostDaemonDirectory } from "./host-daemon-paths.ts";
import { anyGenerationLive } from "./host-gc-evidence.ts";
import {
	clearHandoverParkedSession,
	type HandoverParkedEntry,
	handoverParkedRecordDir,
	readHandoverParkedSessions,
	recordHandoverParkedFailure,
} from "./host-handover-parked.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

/**
 * Opens one parked session on this host, throwing an RpcSessionRegistryError on a refusal. The host
 * supplies one that runs the same open as an `open_session` (senpi#3368), so a reopened session is
 * set up exactly like any other.
 */
export type ParkedSessionOpener = (entry: HandoverParkedEntry) => Promise<void>;

/**
 * A guard against a missed change notification, never the pace of the work: the consumer wakes on every change to
 * the park records, the path claims and the generations (code-yeongyu/oh-my-openagent#10091).
 */
const RESCAN_FALLBACK_MS = 30_000;

/** What woke the consumer. Its own failure records wake it as `record`, which never retries a failed reopen. */
export type ReopenWake = "record" | "claims" | "generations" | "fallback";

/** What the consumer waits on: the host watches its daemon directory, and a test drives every wake itself. */
export interface ReopenWatch {
	/** Registered before the first scan, so a park written while a scan runs wakes the next one. */
	subscribe(wake: (cause: ReopenWake) => void): () => void;
	/** Whether a generation other than this one still runs: it may park another session for this one. */
	predecessorLive(): Promise<boolean>;
	/** Test seam: called each time the consumer waits for its next wake. */
	readonly idle?: () => void;
}

/**
 * The host the watch reopens into. `shouldReopen` returns false once that host is draining for a
 * handoff: a predecessor's own watch must never consume a park it wrote for its successor.
 */
export interface ReopenHolder {
	readonly hostInstance: string;
	readonly hostSocket?: string;
	readonly shouldReopen?: () => boolean;
}

/**
 * senpi#3282: a successor host reopens exactly the set its predecessor held resident and parked with
 * `handoff_parked`, restoring it with the same durable id and `retain_on_disconnect`. It consumes the parks for as
 * long as a predecessor runs or a park remains (code-yeongyu/oh-my-openagent#10091): a session that transfers hours
 * after this host took the socket still reopens here. An entry is removed only after its reopen succeeded and only
 * while it still names that transfer; one whose reopen fails stays, with the failure recorded on it, and is tried
 * again when a claim or a generation changes. An entry whose session file is gone, or whose task ended, is dropped.
 */
export async function reopenHandoverParkedSessions(
	open: ParkedSessionOpener,
	agentDir: string,
	socket: string,
	holder?: ReopenHolder,
	watcher?: ReopenWatch,
): Promise<void> {
	const paths = createHostDaemonPaths({ socket, agentDir });
	// The record directory exists before it is watched: the predecessor's first park may land at any moment.
	await mkdir(handoverParkedRecordDir(paths.dir), { recursive: true, mode: 0o700 }).catch(() => undefined);
	const source = watcher ?? daemonDirectoryWatch(paths, holder?.hostInstance);
	const consumer = new ParkConsumer(paths.dir, open, holder);
	let wake = Promise.withResolvers<void>();
	let woken = false;
	// Whether a predecessor may have ended since it was last seen running: the first pass, or a generation change.
	let livenessDue = true;
	const unsubscribe = source.subscribe((cause) => {
		woken = true;
		if (cause !== "record") consumer.retryFailed();
		if (cause === "generations" || cause === "fallback") livenessDue = true;
		wake.resolve();
	});
	try {
		for (;;) {
			woken = false;
			wake = Promise.withResolvers<void>();
			const remaining = await consumer.pass();
			if (remaining === "stopped") return;
			if (remaining === 0 && livenessDue) {
				livenessDue = false;
				if (!(await predecessorLive(source))) {
					// A predecessor seen ended parks nothing more: one last pass is conclusive.
					const last = await consumer.pass();
					if (last === "stopped" || last === 0) return;
					continue;
				}
			}
			if (woken) continue;
			source.idle?.();
			await wake.promise;
		}
	} finally {
		unsubscribe();
	}
}

class ParkConsumer {
	private readonly daemonDir: string;
	private readonly open: ParkedSessionOpener;
	private readonly holder: ReopenHolder | undefined;
	/** Transfers whose reopen failed since the last claim or generation change: their own record writes never retry them. */
	private readonly failed = new Set<string>();
	private readonly heldTries = new Map<string, number>();

	constructor(daemonDir: string, open: ParkedSessionOpener, holder: ReopenHolder | undefined) {
		this.daemonDir = daemonDir;
		this.open = open;
		this.holder = holder;
	}

	retryFailed(): void {
		this.failed.clear();
	}

	/** Tries every inherited park not tried in this pass until none is new; returns how many remain. */
	async pass(): Promise<number | "stopped"> {
		const tried = new Set<string>();
		for (;;) {
			if (stopped(this.holder)) return "stopped";
			const fresh = (await inheritedParks(this.daemonDir, this.holder)).filter(
				(entry) => !tried.has(transferKey(entry)) && !this.failed.has(transferKey(entry)),
			);
			if (fresh.length === 0) break;
			for (const entry of fresh) {
				tried.add(transferKey(entry));
				if ((await this.reopen(entry)) === "failed") this.failed.add(transferKey(entry));
				if (stopped(this.holder)) return "stopped";
			}
		}
		return (await inheritedParks(this.daemonDir, this.holder)).length;
	}

	private async reopen(entry: HandoverParkedEntry): Promise<"done" | "held" | "failed"> {
		const ended = terminalTaskStatus(entry);
		if (ended !== undefined) {
			await clearHandoverParkedSession(this.daemonDir, entry.sessionPath, entry.transferId);
			process.stderr.write(
				`senpi rpc successor dropped a terminal parked session (${ended}): ${entry.sessionPath}\n`,
			);
			return "done";
		}
		if (!existsSync(entry.sessionPath)) {
			await clearHandoverParkedSession(this.daemonDir, entry.sessionPath, entry.transferId);
			process.stderr.write(
				`senpi rpc successor dropped a parked session whose file is gone: ${entry.sessionPath}\n`,
			);
			return "done";
		}
		try {
			await this.open(entry);
			// The host started draining while this reopen was in flight: the session landed in a registry that is
			// handing off, and the drain parks it again. The record stays for the next generation (senpi#3282).
			if (stopped(this.holder)) return "done";
			await clearHandoverParkedSession(this.daemonDir, entry.sessionPath, entry.transferId);
			return "done";
		} catch (cause) {
			// `session_path_in_use`: the predecessor still holds the path's claim, so the park is waiting, not
			// failing. Its release is a claim change, which wakes the next try.
			if (cause instanceof RpcSessionRegistryError && cause.code === "session_path_in_use") {
				const tries = (this.heldTries.get(entry.sessionPath) ?? 0) + 1;
				this.heldTries.set(entry.sessionPath, tries);
				if (isPowerOfTwo(tries))
					process.stderr.write(
						`senpi rpc successor reopen parked session ${entry.sessionPath} waiting on the holder: ${String(cause)}\n`,
					);
				return "held";
			}
			const attempts = (entry.failedTransfer?.attempts ?? 0) + 1;
			await recordHandoverParkedFailure(this.daemonDir, entry, {
				reason: String(cause),
				at: new Date().toISOString(),
				attempts,
			}).catch((error: unknown) => {
				process.stderr.write(
					`senpi rpc successor could not record the failed reopen of ${entry.sessionPath}: ${String(error)}\n`,
				);
			});
			if (isPowerOfTwo(attempts))
				process.stderr.write(
					`senpi rpc successor reopen parked session ${entry.sessionPath} failed (attempt ${attempts}; kept, tried again on a claim or generation change): ${String(cause)}\n`,
				);
			return "failed";
		}
	}
}

/** The host's own watch: the park records, the path claims and the generations, plus the missed-event fallback. */
function daemonDirectoryWatch(paths: HostDaemonDirectory, self: string | undefined): ReopenWatch {
	return {
		subscribe(wake) {
			const watched: ReadonlyArray<readonly [string, ReopenWake]> = [
				[handoverParkedRecordDir(paths.dir), "record"],
				[paths.reservationsDir, "claims"],
				[paths.generationsDir, "generations"],
			];
			const watchers: FSWatcher[] = [];
			for (const [dir, cause] of watched) {
				try {
					const watcher = watch(dir, { persistent: false }, () => wake(cause));
					// A directory removed under the watch ends it; the fallback rescan still runs.
					watcher.on("error", () => watcher.close());
					watchers.push(watcher);
				} catch {
					// Not created yet (no claim or generation recorded here): the fallback rescan covers it.
				}
			}
			const fallback = setInterval(() => wake("fallback"), RESCAN_FALLBACK_MS);
			fallback.unref();
			return () => {
				for (const watcher of watchers) watcher.close();
				clearInterval(fallback);
			};
		},
		predecessorLive: () => anyGenerationLive(paths, self),
	};
}

/** An unreadable generation state errs toward a live predecessor: the consumer keeps waiting rather than miss a park. */
function predecessorLive(source: ReopenWatch): Promise<boolean> {
	return source.predecessorLive().catch(() => true);
}

/**
 * The parks a PREVIOUS generation left for this one. A park this host wrote itself (its idle sweep
 * parks retained sessions into the same record) is for its successor: reopening it here would put a
 * second open of the path in flight against the client reopening it (senpi#3485).
 */
async function inheritedParks(
	daemonDir: string,
	holder: ReopenHolder | undefined,
): Promise<readonly HandoverParkedEntry[]> {
	const parked = await readHandoverParkedSessions(daemonDir);
	return parked.filter((entry) => entry.parkedBy === undefined || entry.parkedBy !== holder?.hostInstance);
}

function terminalTaskStatus(entry: HandoverParkedEntry): string | undefined {
	const taskStatus =
		entry.contextOverlay && Object.hasOwn(entry.contextOverlay, "task_status")
			? entry.contextOverlay.task_status
			: entry.sessionContext?.task_status;
	return typeof taskStatus === "string" &&
		["completed", "cancelled", "error", "failed", "lost", "interrupted"].includes(taskStatus)
		? taskStatus
		: undefined;
}

function stopped(holder: ReopenHolder | undefined): boolean {
	return holder?.shouldReopen !== undefined && !holder.shouldReopen();
}

function transferKey(entry: HandoverParkedEntry): string {
	return `${entry.sessionPath}\n${entry.transferId ?? ""}`;
}

function isPowerOfTwo(count: number): boolean {
	return (count & (count - 1)) === 0;
}
