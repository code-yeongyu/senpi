import type { SessionEntry, SessionProjection } from "./session-manager.ts";

/**
 * Whether an assistant's provider-reported usage still describes the model context after
 * `context_edit` entries (boundary omissions and replacements) changed that context.
 */
export interface AssistantUsageScope {
	/** The assistant still contributes a message to the current projection. */
	readonly projected: boolean;
	/** Its usage describes the current context: projected and no later context edit on the branch. */
	readonly usageMatchesProjection: boolean;
	/** An explicit overflow error stays recoverable: not omitted by a later edit and not behind a compaction. */
	readonly retainedForExplicitRecovery: boolean;
}

/** An assistant without a persisted entry is judged as projected, like the upstream session core. */
export function resolveAssistantUsageScope(
	branch: readonly SessionEntry[],
	buildProjection: () => SessionProjection,
	assistantEntryId: string | undefined,
): AssistantUsageScope {
	if (assistantEntryId === undefined) {
		return { projected: true, usageMatchesProjection: true, retainedForExplicitRecovery: true };
	}
	const assistantIndex = branch.findIndex((entry) => entry.id === assistantEntryId);
	const later = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
	if (assistantIndex >= 0 && !later.some((entry) => entry.type === "context_edit" || entry.type === "compaction")) {
		return { projected: true, usageMatchesProjection: true, retainedForExplicitRecovery: true };
	}
	const projected = buildProjection().entries.some(
		(entry) =>
			entry.sourceEntry.id === assistantEntryId && entry.messages.some((message) => message.role === "assistant"),
	);
	const latestEdit = later
		.filter((entry) => entry.type === "context_edit" && entry.targetId === assistantEntryId)
		.at(-1);
	const omitted = latestEdit?.type === "context_edit" && latestEdit.replacement === null;
	return {
		projected,
		usageMatchesProjection: projected && !later.some((entry) => entry.type === "context_edit"),
		retainedForExplicitRecovery: !omitted && !later.some((entry) => entry.type === "compaction"),
	};
}
