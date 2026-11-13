/**
 * The retained-session record a host keeps for the NEXT start of its endpoint: one per-session
 * entry in the handover-parked record (`host-handover-parked.ts`), written when a session becomes
 * retained-and-resident here, moved when the session switches to another transcript, and rewritten
 * when it parks. A restart on the same socket and agent dir - after a handoff, a crash, or a kill
 * mid-turn - reopens every entry a previous process wrote by its session file, the way a TUI resumes
 * from its session file, so `list_sessions` (and the relay that mirrors it) lists the session again
 * without anyone re-opening it by hand.
 */
import { clearHandoverParkedSession, recordHandoverParkedSession } from "./host-handover-parked.ts";
import { parkedEntryFromProfile } from "./host-handover-parked-open.ts";
import { currentResidentWriter } from "./host-handover-resident-writer.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import type { RouterContext } from "./session-router-context.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";

const reportRecordFailure = (sessionId: string) => (cause: unknown) => {
	process.stderr.write(`senpi rpc retained session record ${sessionId} failed: ${String(cause)}\n`);
};

/**
 * Writes the record entry of a retained session under `sessionPath`, stamped with this host instance, and drops
 * the entry it was recorded under before when the session has since moved to another transcript (senpi#6190).
 * `resident` stamps the writing process: the session is open here. A park writes it unstamped.
 */
export function recordRetainedSession(
	host: RouterContext,
	retained: RpcSessionEntry,
	sessionPath: string,
	resident: boolean,
): Promise<void> {
	const dir = host.handoverParkedDir;
	if (dir === undefined) return Promise.resolve();
	const previous = retained.recordedPath;
	retained.recordedPath = sessionPath;
	// One session's writes land in the order they were issued. A stamped write that first clears a switched-from entry
	// would otherwise reach the record after a park issued later, leaving the parked session stamped resident.
	const write = () => writeRetainedRecord(host, dir, retained, sessionPath, previous, resident);
	const next = (retained.recordWrite ?? Promise.resolve()).then(write, write);
	retained.recordWrite = next.catch(() => {});
	return next;
}

async function writeRetainedRecord(
	host: RouterContext,
	dir: string,
	retained: RpcSessionEntry,
	sessionPath: string,
	previous: string | undefined,
	resident: boolean,
): Promise<void> {
	if (previous !== undefined && previous !== sessionPath) await clearHandoverParkedSession(dir, previous);
	const durableSessionId = retained.runtime?.session.sessionId ?? retained.durableSessionId;
	await recordHandoverParkedSession(dir, {
		...parkedEntryFromProfile(
			{
				sessionPath,
				contextOverlay: retained.contextOverlay,
				...(durableSessionId !== undefined ? { durableSessionId } : {}),
			},
			retained.profile,
			Object.keys(host.defaults.hostContext ?? {}),
		),
		parkedBy: host.defaults.hostContext?.host_instance ?? hostInstanceId(),
		...(resident ? { residentWriter: currentResidentWriter() } : {}),
	});
}

/** The session path a live entry writes now; a replacement moves it before the registry's metadata catches up. */
const currentPath = (entry: RpcSessionEntry): string | undefined =>
	entry.runtime?.session.sessionFile ?? entry.sessionPath;

/**
 * Brings the record in line with a session this host just opened or attached: a retained session is
 * recorded as resident here, so a restart reopens it; a non-retained open by path supersedes any
 * earlier park of that path, whose entry is cleared so no later start reopens a second copy
 * (MEDIUM-1, senpi#3282 review). Runs only after the open succeeded, so a failed open keeps the entry.
 */
export async function syncRetainedRecord(
	host: RouterContext,
	sessionId: string,
	requestedPath: string | undefined,
): Promise<void> {
	const dir = host.handoverParkedDir;
	if (dir === undefined) return;
	const entry = host.registry.peek(sessionId);
	const sessionPath = entry === undefined ? undefined : currentPath(entry);
	if (entry?.retainOnDisconnect === true && sessionPath !== undefined) {
		await recordRetainedSession(host, entry, sessionPath, true).catch(reportRecordFailure(sessionId));
		if (requestedPath === undefined || requestedPath === sessionPath) return;
	}
	if (requestedPath !== undefined) await clearHandoverParkedSession(dir, requestedPath).catch(() => {});
}

/**
 * Called after every record a session publishes: a retained session whose transcript was switched (`new_session`,
 * `switch_session`, a fork) moves its record entry to the new file at once, so a crash restores the transcript the
 * session is on, never the one it left. A string compare until the path actually moves.
 */
export function followRetainedRecord(host: RouterContext, sessionId: string): void {
	if (host.handoverParkedDir === undefined) return;
	const entry = host.registry.peek(sessionId);
	if (entry?.retainOnDisconnect !== true || entry.recordedPath === undefined || entry.state !== "open") return;
	const sessionPath = currentPath(entry);
	if (sessionPath === undefined || sessionPath === entry.recordedPath) return;
	void recordRetainedSession(host, entry, sessionPath, true).catch(reportRecordFailure(sessionId));
}

/** An explicit close or reclaim ends the session for good: drop every key its record was written under. */
export async function clearRetainedRecord(host: RouterContext, entry: RpcSessionEntry | undefined): Promise<void> {
	const dir = host.handoverParkedDir;
	if (dir === undefined || entry === undefined) return;
	const keys = new Set([entry.recordedPath, entry.sessionPath, entry.runtime?.session.sessionFile]);
	entry.recordedPath = undefined;
	for (const key of keys) if (key !== undefined) await clearHandoverParkedSession(dir, key).catch(() => {});
}
