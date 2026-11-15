import type { CompactionPreparation, FileOperations } from "../../core/compaction/index.ts";

// Which fields each part of a forwarded loop event may carry (senpi#5898). The parts the loop-hook lane defines itself
// are strict: an event's envelope, a compaction preparation and its file sets (and, in compaction-settings-schema.ts,
// its settings). The hand refuses a field they do not name instead of dropping it unread. The transcript messages and
// session entries an envelope carries stay open; see agent-message-schema.ts for why.

const SESSION_FIELDS: readonly string[] = ["sessionId", "idle", "scope"];

const ENVELOPE_FIELDS = new Map<string, readonly string[]>([
	["input", ["inputId", "text", "source", "attribution", "streamingBehavior", "images"]],
	["before_agent_start", ["prompt", "systemPrompt", "trigger", "preview", "systemPromptOptions", "images"]],
	["before_provider_request", ["input"]],
	["session_start", ["reason", "previousSessionFile"]],
	["agent_end", ["messages", "aborted", "leafId", "handEntries"]],
	[
		"session_before_compact",
		["reason", "requestId", "willRetry", "customInstructions", "preparation", "branchEntries"],
	],
	[
		"session_compact",
		["reason", "requestId", "accepted", "compactionEntry", "rejectionCause", "fromExtension", "willRetry"],
	],
	["session_compact_failed", ["reason", "errorMessage", "aborted", "willRetry", "fromExtension"]],
	["session_shutdown", ["reason", "targetSessionFile"]],
]);

/** The first field of `payload` that `event`'s envelope does not name; none for an event the hand does not serve. */
export function unknownEnvelopeField(event: string, payload: Record<string, unknown>): string | undefined {
	const fields = ENVELOPE_FIELDS.get(event);
	if (fields === undefined) return undefined;
	return Object.keys(payload).find((key) => !SESSION_FIELDS.includes(key) && !fields.includes(key));
}

export const PREPARATION_FIELDS = {
	firstKeptEntryId: true,
	messagesToSummarize: true,
	sourceMessages: true,
	turnPrefixMessages: true,
	turnPrefixSourceMessages: true,
	isSplitTurn: true,
	tokensBefore: true,
	previousSummary: true,
	fileOps: true,
	settings: true,
} as const satisfies Record<keyof CompactionPreparation, true>;

export const FILE_OPS_FIELDS = { read: true, written: true, edited: true } as const satisfies Record<
	keyof FileOperations,
	true
>;

export const hasOnlyFields = (value: Record<string, unknown>, allowed: Readonly<Record<string, true>>): boolean =>
	Object.keys(value).every((key) => Object.hasOwn(allowed, key));
