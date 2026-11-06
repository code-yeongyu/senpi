import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, ProjectedSessionEntry, SessionEntry } from "./session-manager.ts";
import { type ReplyLanguage, recordedReplyLanguage, replyLanguageOf } from "./user-language.ts";

/**
 * The reply language a compaction entry records (omo#11527, omo#12625). It is read from the whole
 * context the compaction replaces, previous summary included, before the resident mirror is trimmed
 * to the new window (senpi#3519): after that trim the turns that set the language are gone, so a
 * chained compaction (every deterministic checkpoint of one long tool-heavy turn) could not read it.
 */
export function compactionReplyLanguageFields(
	context: readonly AgentMessage[],
): Pick<CompactionEntry, "userLanguage" | "userLanguageRequested"> {
	const replyLanguage = replyLanguageOf(context);
	return replyLanguage === undefined
		? {}
		: { userLanguage: replyLanguage.language, userLanguageRequested: replyLanguage.requested };
}

/**
 * The summary replaces the user's own turns, so it carries the reply language they established: the
 * one the entry recorded, else (an entry written before the record existed) the one the user
 * messages still on the path establish.
 */
export function annotateCompactionUserLanguage(head: ProjectedSessionEntry | undefined, path: SessionEntry[]): void {
	if (head?.sourceEntry.type !== "compaction") return;
	const replyLanguage = compactionReplyLanguage(head.sourceEntry, path);
	if (replyLanguage === undefined) return;
	for (const message of head.messages) {
		if (message.role !== "compactionSummary") continue;
		message.userLanguage = replyLanguage.language;
		message.userLanguageRequested = replyLanguage.requested;
	}
}

function compactionReplyLanguage(entry: CompactionEntry, path: SessionEntry[]): ReplyLanguage | undefined {
	if (entry.userLanguage !== undefined) return recordedReplyLanguage(entry.userLanguage, entry.userLanguageRequested);
	const end = path.indexOf(entry);
	return replyLanguageOf(
		path
			.slice(0, Math.max(end, 0))
			.flatMap((pathEntry) =>
				pathEntry.type === "message" && pathEntry.message.role === "user" ? [pathEntry.message] : [],
			),
	);
}
