/**
 * The retained-session record a host keeps for the NEXT start of its endpoint: one per-session
 * entry in the handover-parked record (`host-handover-parked.ts`), written when a session becomes
 * retained-and-resident here and rewritten when it parks. A restart on the same socket and agent
 * dir - after a handoff, a crash, or a kill mid-turn - reopens every entry a previous process wrote
 * by its session file, the way a TUI resumes from its session file, so `list_sessions` (and the
 * relay that mirrors it) lists the session again without anyone re-opening it by hand.
 */
import { clearHandoverParkedSession, recordHandoverParkedSession } from "./host-handover-parked.ts";
import { parkedEntryFromProfile } from "./host-handover-parked-open.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import type { RouterContext } from "./session-router-context.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";

export function recordRetainedSession(
	host: RouterContext,
	retained: RpcSessionEntry,
	sessionPath: string,
): Promise<void> {
	if (host.handoverParkedDir === undefined) return Promise.resolve();
	return recordHandoverParkedSession(host.handoverParkedDir, {
		...parkedEntryFromProfile(
			{
				sessionPath,
				contextOverlay: retained.contextOverlay,
				...(retained.durableSessionId !== undefined ? { durableSessionId: retained.durableSessionId } : {}),
			},
			retained.profile,
			Object.keys(host.defaults.hostContext ?? {}),
		),
		parkedBy: host.defaults.hostContext?.host_instance ?? hostInstanceId(),
	});
}

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
	const sessionPath = entry?.sessionPath;
	if (entry?.retainOnDisconnect === true && sessionPath !== undefined) {
		await recordRetainedSession(host, entry, sessionPath).catch((cause: unknown) => {
			process.stderr.write(`senpi rpc retained session record ${sessionId} failed: ${String(cause)}\n`);
		});
		if (requestedPath === undefined || requestedPath === sessionPath) return;
	}
	if (requestedPath !== undefined) await clearHandoverParkedSession(dir, requestedPath).catch(() => {});
}
