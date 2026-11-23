import { dirname } from "node:path";
import type { SessionContext } from "./extensions/types.ts";
import { fsJournalDurability, type JournalDurability } from "./pending-input-journal.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionManager } from "./session-manager.ts";

/**
 * `open_session.context.approvals = "refuse"`: the opener declares that nobody answers this session's prompts
 * (oh-my-openagent#14649). The engine records it in the session as a `permission-approvals-refused` entry naming the
 * session id; the permission system refuses every ask in a session that carries the label or the record.
 */
const REFUSE_APPROVALS_CONTEXT_KEY = "approvals";
const REFUSE_APPROVALS_CONTEXT_VALUE = "refuse";
const REFUSE_APPROVALS_ENTRY_TYPE = "permission-approvals-refused";

type RecordingSession = Pick<
	SessionManager,
	| "appendCustomEntry"
	| "getSessionFile"
	| "getSessionId"
	| "isPersisted"
	| "isTranscriptFlushed"
	| "persistHeaderNow"
	| "reduceHistory"
>;

class OpenerRefusalNotDurableError extends Error {
	constructor(sessionFile: string | undefined) {
		super(`The approvals refusal could not be written to the session file (${sessionFile ?? "no file"})`);
		this.name = "OpenerRefusalNotDurableError";
	}
}

export function refusesApprovals(context: SessionContext | undefined): boolean {
	return context?.[REFUSE_APPROVALS_CONTEXT_KEY] === REFUSE_APPROVALS_CONTEXT_VALUE;
}

/**
 * The label is the opener's own declaration, so it reaches only the session that open created or reopened. A session
 * the runtime replaces it with later (`new_session`, `switch_session`, `fork`, `clone`, an import) is built from the
 * open's launch profile without it: it refuses only when it carries its own record.
 */
export function replacementLaunchProfile<P extends { readonly sessionContext?: SessionContext }>(
	profile: P | undefined,
): P | undefined {
	if (profile === undefined || !refusesApprovals(profile.sessionContext)) return profile;
	const { [REFUSE_APPROVALS_CONTEXT_KEY]: _label, ...sessionContext } = profile.sessionContext ?? {};
	return Object.freeze({ ...profile, sessionContext });
}

/** Session ids the history records a refusal for; a fork copies its source's record under the source's id. */
const refusalRecords: HistoryReducer<Set<string>> = {
	initial: () => new Set(),
	add: (ids, entry) => {
		if (entry.type !== "custom" || entry.customType !== REFUSE_APPROVALS_ENTRY_TYPE) return ids;
		const sessionId = (entry.data as { sessionId?: unknown } | undefined)?.sessionId;
		if (typeof sessionId === "string") ids.add(sessionId);
		return ids;
	},
};

export function hasOpenerRefusal(session: Pick<SessionManager, "getSessionId" | "reduceHistory">): boolean {
	return session.reduceHistory(refusalRecords).has(session.getSessionId());
}

/**
 * Records the refusal for a labelled open (or attach) before the session starts or the attach is answered. A persisted session must have it in its file and
 * synced (the header is forced so the entry reaches the file itself, not the buffer that waits for the first message);
 * anything less rejects, and the open fails instead of starting a session that could later ask. A session opened
 * without persistence keeps the record in memory, like the rest of that session.
 */
export async function recordOpenerRefusal(
	session: RecordingSession,
	durability: JournalDurability = fsJournalDurability(),
): Promise<void> {
	const recorded = hasOpenerRefusal(session);
	const record = { sessionId: session.getSessionId() };
	if (!session.isPersisted()) {
		if (!recorded) session.appendCustomEntry(REFUSE_APPROVALS_ENTRY_TYPE, record);
		return;
	}
	await session.persistHeaderNow();
	const file = session.getSessionFile();
	if (file === undefined || !session.isTranscriptFlushed()) throw new OpenerRefusalNotDurableError(file);
	if (!recorded) session.appendCustomEntry(REFUSE_APPROVALS_ENTRY_TYPE, record);
	// Synced even when the record was already there: a readable record is not proof that an earlier sync succeeded.
	await durability.syncFile(file);
	await durability.syncDirectory(dirname(file));
}
