import type { CompactionPreparation, CompactionSettings, FileOperations } from "../../core/compaction/index.ts";
import type {
	CompactionReason,
	CompactionRejectionCause,
	SessionCompactEvent,
	SessionCompactFailedEvent,
} from "../../core/extensions/types.ts";
import type { CompactionEntry } from "../../core/session-manager.ts";
import {
	isBoolean,
	isOneOf,
	isOptional,
	isRecord,
	isSessionEntries,
	isSessionEntry,
	isString,
	isStrings,
	loopHookFamily,
	malformed,
	forwarded,
} from "./loop-hook-payloads.ts";
import { isAgentMessages } from "./loop-hook-message-shapes.ts";

// A hosted loop's compaction (senpi#5898): `session_before_compact` returns its combined result (`cancel`,
// `compaction`) as a session's emit does; `session_compact` and `session_compact_failed` are notifications.

const COMPACTION_REASONS = [
	"manual",
	"threshold",
	"overflow",
	"pre_prompt",
	"branch",
	"extension",
] as const satisfies readonly CompactionReason[];
const REJECTION_CAUSES = [
	"cancelled-by-extension",
	"external-owner",
	"would-overflow",
	"circuit-breaker",
	"per-turn-cap",
	"stale-revision",
] as const satisfies readonly CompactionRejectionCause[];
const COMPACTION_FAILED_REASONS = [
	"manual",
	"threshold",
	"overflow",
] as const satisfies readonly SessionCompactFailedEvent["reason"][];

const isCompactionEntry = (value: unknown): value is CompactionEntry =>
	isSessionEntry(value) &&
	value.type === "compaction" &&
	typeof value.summary === "string" &&
	typeof value.firstKeptEntryId === "string" &&
	typeof value.tokensBefore === "number";

/** The file sets of a preparation, which travel as arrays (a `Set` has no JSON form); `null` when malformed. */
function fileOpsOf(value: unknown): FileOperations | null {
	if (!isRecord(value) || !isStrings(value.read) || !isStrings(value.written) || !isStrings(value.edited)) return null;
	return { read: new Set(value.read), written: new Set(value.written), edited: new Set(value.edited) };
}

const isCompactionSettings = (value: unknown): value is CompactionSettings =>
	isRecord(value) &&
	typeof value.enabled === "boolean" &&
	typeof value.reserveTokens === "number" &&
	typeof value.keepRecentTokens === "number";

function preparationOf(value: unknown): CompactionPreparation | null {
	if (!isRecord(value)) return null;
	const { firstKeptEntryId, messagesToSummarize, sourceMessages, turnPrefixMessages, turnPrefixSourceMessages } =
		value;
	const { isSplitTurn, tokensBefore, previousSummary, settings } = value;
	const fileOps = fileOpsOf(value.fileOps);
	if (
		typeof firstKeptEntryId !== "string" ||
		!isAgentMessages(messagesToSummarize) ||
		!isOptional(sourceMessages, isAgentMessages) ||
		!isAgentMessages(turnPrefixMessages) ||
		!isOptional(turnPrefixSourceMessages, isAgentMessages) ||
		typeof isSplitTurn !== "boolean" ||
		typeof tokensBefore !== "number" ||
		!isOptional(previousSummary, isString) ||
		fileOps === null ||
		!isCompactionSettings(settings)
	)
		return null;
	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		fileOps,
		settings,
		...(sourceMessages === undefined ? {} : { sourceMessages }),
		...(turnPrefixSourceMessages === undefined ? {} : { turnPrefixSourceMessages }),
		...(previousSummary === undefined ? {} : { previousSummary }),
	};
}

function sessionCompactOf(payload: Record<string, unknown>): SessionCompactEvent {
	const { reason, requestId, accepted, compactionEntry, rejectionCause, fromExtension, willRetry } = payload;
	if (!isOneOf(reason, COMPACTION_REASONS) || typeof requestId !== "string") throw malformed("session_compact");
	const base = { type: "session_compact" as const, reason, requestId };
	if (accepted === true && isCompactionEntry(compactionEntry) && isBoolean(fromExtension) && isBoolean(willRetry))
		return { ...base, accepted, compactionEntry, fromExtension, willRetry };
	if (
		accepted === false &&
		isOneOf(rejectionCause, REJECTION_CAUSES) &&
		fromExtension === false &&
		willRetry === false
	)
		return { ...base, accepted, rejectionCause, fromExtension, willRetry };
	throw malformed("session_compact");
}

export const COMPACTION_LOOP_HOOKS = loopHookFamily({
	session_before_compact: (payload) => {
		const { reason, requestId, willRetry, customInstructions, branchEntries } = payload;
		const preparation = preparationOf(payload.preparation);
		if (
			!isOneOf(reason, COMPACTION_REASONS) ||
			typeof requestId !== "string" ||
			typeof willRetry !== "boolean" ||
			!isOptional(customInstructions, isString) ||
			preparation === null ||
			!isSessionEntries(branchEntries)
		)
			throw malformed("session_before_compact");
		const event = {
			type: "session_before_compact" as const,
			reason,
			requestId,
			willRetry,
			preparation,
			branchEntries,
			...(customInstructions === undefined ? {} : { customInstructions }),
		};
		return { emit: ({ runner, only, signal }) => runner.emitForwardedLoopEvent({ ...event, signal }, only) };
	},
	session_compact: (payload) => forwarded(sessionCompactOf(payload)),
	session_compact_failed: ({ reason, errorMessage, aborted, willRetry, fromExtension }) => {
		if (
			!isOneOf(reason, COMPACTION_FAILED_REASONS) ||
			!isOptional(errorMessage, isString) ||
			!isBoolean(aborted) ||
			!isBoolean(willRetry) ||
			!isBoolean(fromExtension)
		)
			throw malformed("session_compact_failed");
		return forwarded({
			type: "session_compact_failed",
			reason,
			aborted,
			willRetry,
			fromExtension,
			...(errorMessage === undefined ? {} : { errorMessage }),
		});
	},
});
