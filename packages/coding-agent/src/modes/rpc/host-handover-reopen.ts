import { existsSync } from "node:fs";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import {
	clearHandoverParkedSession,
	dropHandoverParkedSessionIfFileGone,
	type HandoverParkedEntry,
	readHandoverParkedSessions,
} from "./host-handover-parked.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

/**
 * Opens one parked session on this host, throwing an RpcSessionRegistryError on a refusal. The host
 * supplies one that runs the same open as an `open_session` (senpi#3368), so a reopened session is
 * set up exactly like any other.
 */
export type ParkedSessionOpener = (entry: HandoverParkedEntry) => Promise<void>;

// The watch budget must outlast a heavily loaded drain: a predecessor whose event loop is blocked
// (parallel hosts, a busy turn settling) can take tens of seconds to write its park after this
// generation binds. The record persists until a successful reopen consumes it, so a generous
// budget is safe: the watch is a background task that never blocks readiness, and it returns early
// once the record has been drained and stayed empty for the quiet streak.
const HANDOVER_PARKED_REOPEN_BUDGET_MS = 120_000;
const HANDOVER_PARKED_REOPEN_POLL_MS = 250;
const HANDOVER_PARKED_REOPEN_MAX_ATTEMPTS = 8;
const HANDOVER_PARKED_REOPEN_QUIET_STREAK = 8;

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
 * senpi#3282: a successor host reopens exactly the set its predecessor held resident and parked
 * with `handoff_parked`, restoring it with the same durable id and `retain_on_disconnect`. An
 * entry is removed from the record only after a successful reopen (crash-safe, at most once); an
 * entry whose session file is gone is logged and dropped. Runs once at host startup.
 */
export async function reopenHandoverParkedSessions(
	open: ParkedSessionOpener,
	agentDir: string,
	socket: string,
	holder?: ReopenHolder,
): Promise<void> {
	const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
	// The predecessor parks its retained sessions AFTER this generation binds the public socket (its
	// drain fires on detecting supersession), so the record is not necessarily present at startup,
	// and a session still busy at the drain start parks only after its turn settles. Returning on the
	// first empty read would drop those. Keep watching until the record has stayed empty for a
	// sustained streak - the drain has finished writing by then - bounded by the window. Entries are
	// removed only after a successful reopen (crash-safe, at most once, never lost).
	//
	// The empty-streak early-exit only applies once a park has actually been seen: under load the
	// predecessor's drain can be delayed past the whole quiet streak while it has not written a
	// single entry yet, and returning then would skip a park that lands late (senpi#3282 review).
	// Before the first entry arrives, only the budget ends the watch. The record persists until a
	// successful reopen consumes it, so the watch can afford a generous budget: a predecessor whose
	// event loop is starved by parallel hosts still parks eventually, and the entry is waiting when
	// it does. Once a park has been seen and the record has stayed empty for the quiet streak, the
	// drain is finished and the watch returns early.
	const deadline = Date.now() + HANDOVER_PARKED_REOPEN_BUDGET_MS;
	const reopenAttempts = new Map<string, number>();
	const heldPolls = new Map<string, number>();
	let emptyStreak = 0;
	let sawAnyPark = false;
	for (;;) {
		// A draining predecessor must not reopen into its own registry a session it just parked for
		// its successor: stop consuming the record and leave every entry for the next generation
		// (senpi#3282). The watch returns, the record persists, and the successor's own watch reopens
		// it by path with the same durable id.
		if (holder?.shouldReopen !== undefined && !holder.shouldReopen()) return;
		const parked = await inheritedParks(daemonDir, holder);
		for (const entry of parked) {
			sawAnyPark = true;
			await reopenOne(daemonDir, open, entry, reopenAttempts, heldPolls, holder);
		}
		const remaining = (await inheritedParks(daemonDir, holder)).length;
		emptyStreak = remaining === 0 ? emptyStreak + 1 : 0;
		if (sawAnyPark && emptyStreak >= HANDOVER_PARKED_REOPEN_QUIET_STREAK) return;
		if (Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, HANDOVER_PARKED_REOPEN_POLL_MS));
	}
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

async function reopenOne(
	daemonDir: string,
	open: ParkedSessionOpener,
	entry: HandoverParkedEntry,
	attempts: Map<string, number>,
	heldPolls?: Map<string, number>,
	holder?: ReopenHolder,
): Promise<void> {
	await dropHandoverParkedSessionIfFileGone(daemonDir, entry.sessionPath);
	if (!existsSync(entry.sessionPath)) {
		process.stderr.write(`senpi rpc successor dropped a parked session whose file is gone: ${entry.sessionPath}\n`);
		return;
	}
	try {
		await open(entry);
		// The host started draining while this reopen was in flight: the session landed in a registry
		// that is handing off, and the drain parks it again. Keep the record so the successor still
		// reopens it; clearing it here would lose the session when the drain closes it (senpi#3282).
		if (holder?.shouldReopen !== undefined && !holder.shouldReopen()) return;
		await clearHandoverParkedSession(daemonDir, entry.sessionPath);
	} catch (cause) {
		// A `session_path_in_use` refusal means the predecessor still holds the path's cross-generation
		// claim (its drain has not released it yet): the holder is alive, so the park is not failing -
		// it is waiting. It is retried on the next poll, bounded only by the watch budget, and it is
		// NOT counted toward the attempt cap. Only a genuine failure consumes an attempt: if held
		// refusals also counted, ~2s of holding would push the count past the cap, and the first real
		// failure after the predecessor releases the path would drop the entry at once (M1).
		const heldByPredecessor = cause instanceof RpcSessionRegistryError && cause.code === "session_path_in_use";
		if (heldByPredecessor) {
			// Throttle the hold log: a slow drain can hold the path for the whole budget, and a line
			// every 250 ms is ~480 lines of noise. Log the first hold, then about once every 10 s.
			const polls = (heldPolls?.get(entry.sessionPath) ?? 0) + 1;
			heldPolls?.set(entry.sessionPath, polls);
			if (polls === 1 || polls % 40 === 0)
				process.stderr.write(
					`senpi rpc successor reopen parked session ${entry.sessionPath} waiting on the holder: ${String(cause)}\n`,
				);
			return;
		}
		const tried = (attempts.get(entry.sessionPath) ?? 0) + 1;
		attempts.set(entry.sessionPath, tried);
		if (tried >= HANDOVER_PARKED_REOPEN_MAX_ATTEMPTS) {
			process.stderr.write(
				`senpi rpc successor gave up reopening parked session ${entry.sessionPath} after ${tried} attempts: ${String(cause)}\n`,
			);
			await clearHandoverParkedSession(daemonDir, entry.sessionPath);
			return;
		}
		process.stderr.write(`senpi rpc successor reopen parked session ${entry.sessionPath} failed: ${String(cause)}\n`);
	}
}
