import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { CompactionPreparation, CompactionSettings, FileOperations } from "../../core/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	CompactionReason,
	CompactionRejectionCause,
	InputAttribution,
	InputSource,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../core/extensions/types.ts";
import type { CompactionEntry, CustomEntry, SessionEntry } from "../../core/session-manager.ts";
import type { CarriedSession } from "./loop-hook-call.ts";

// The hand's boundary for the loop events a hosted loop forwards (senpi#5898): each payload is parsed here into the
// event its handlers see in a session, or refused as malformed; nothing past this module re-checks a payload.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const INPUT_SOURCES = ["interactive", "rpc", "extension"] as const satisfies readonly InputSource[];
export const INPUT_ATTRIBUTIONS = ["user", "agent"] as const satisfies readonly InputAttribution[];
export const STREAMING_BEHAVIORS = ["steer", "followUp"] as const;
export const TRIGGERS = [
	"prompt",
	"delivery",
	"extension",
] as const satisfies readonly BeforeAgentStartEvent["trigger"][];
const SESSION_START_REASONS = [
	"startup",
	"reload",
	"new",
	"resume",
	"fork",
] as const satisfies readonly SessionStartEvent["reason"][];
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
const SHUTDOWN_REASONS = [
	"quit",
	"reload",
	"new",
	"resume",
	"fork",
] as const satisfies readonly SessionShutdownEvent["reason"][];

export const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
	typeof value === "string" && (allowed as readonly string[]).includes(value);

const isString = (value: unknown): value is string => typeof value === "string";
const isOptional = <T>(value: unknown, is: (value: unknown) => value is T): value is T | undefined =>
	value === undefined || is(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

/** The images of a loop event, `undefined` when it has none, `null` when they are malformed. */
export const imagesOf = (value: unknown): ImageContent[] | undefined | null =>
	value === undefined ? undefined : Array.isArray(value) && value.every(isImage) ? value : null;

const isImage = (value: unknown): value is ImageContent =>
	isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";

/** The loop's transcript messages, as data its handlers read (the Stop hook its last stop reason). */
export const isAgentMessages = (value: unknown): value is AgentMessage[] =>
	Array.isArray(value) && value.every((message) => isRecord(message) && typeof message.role === "string");

const isSessionEntry = (value: unknown): value is SessionEntry =>
	isRecord(value) &&
	typeof value.type === "string" &&
	typeof value.id === "string" &&
	(value.parentId === null || typeof value.parentId === "string") &&
	typeof value.timestamp === "string";

const isCustomEntry = (value: unknown): value is CustomEntry =>
	isSessionEntry(value) && value.type === "custom" && typeof value.customType === "string";

const isCompactionEntry = (value: unknown): value is CompactionEntry =>
	isSessionEntry(value) &&
	value.type === "compaction" &&
	typeof value.summary === "string" &&
	typeof value.firstKeptEntryId === "string" &&
	typeof value.tokensBefore === "number";

/**
 * The session port's read half a call carries (`leafId`, `handEntries`; see `CarriedSession`), or `null` when
 * malformed. Each hand entry is a custom entry: the hand only ever authored custom entries.
 */
export function carriedSessionOf(payload: Record<string, unknown>): CarriedSession | null {
	const { leafId, handEntries } = payload;
	if (!(leafId === null || typeof leafId === "string")) return null;
	if (!Array.isArray(handEntries) || !handEntries.every(isCustomEntry)) return null;
	return { leafId, handEntries };
}

const malformed = (event: string): Error => new Error(`malformed ${event} payload`);

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

/** A forwarded `session_before_compact`, except its `signal`, which the hand builds for the call. */
export function sessionBeforeCompactOf(payload: Record<string, unknown>): Omit<SessionBeforeCompactEvent, "signal"> {
	const { reason, requestId, willRetry, customInstructions, branchEntries } = payload;
	const preparation = preparationOf(payload.preparation);
	if (
		!isOneOf(reason, COMPACTION_REASONS) ||
		typeof requestId !== "string" ||
		typeof willRetry !== "boolean" ||
		!isOptional(customInstructions, isString) ||
		preparation === null ||
		!Array.isArray(branchEntries) ||
		!branchEntries.every(isSessionEntry)
	)
		throw malformed("session_before_compact");
	return {
		type: "session_before_compact",
		reason,
		requestId,
		willRetry,
		preparation,
		branchEntries,
		...(customInstructions === undefined ? {} : { customInstructions }),
	};
}

/** The forwarded loop events whose handlers return nothing; their effects travel back in the reply. */
export type LoopNotification =
	| SessionStartEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent;

/** The notification `event` names, parsed from its payload; `undefined` when `event` is not one. */
export function loopNotificationOf(event: string, payload: Record<string, unknown>): LoopNotification | undefined {
	switch (event) {
		case "session_start": {
			const { reason, previousSessionFile } = payload;
			if (!isOneOf(reason, SESSION_START_REASONS) || !isOptional(previousSessionFile, isString))
				throw malformed(event);
			return { type: event, reason, ...(previousSessionFile === undefined ? {} : { previousSessionFile }) };
		}
		case "session_compact":
			return sessionCompactOf(payload);
		case "session_compact_failed": {
			const { reason, errorMessage, aborted, willRetry, fromExtension } = payload;
			if (
				!isOneOf(reason, COMPACTION_FAILED_REASONS) ||
				!isOptional(errorMessage, isString) ||
				typeof aborted !== "boolean" ||
				typeof willRetry !== "boolean" ||
				typeof fromExtension !== "boolean"
			)
				throw malformed(event);
			return {
				type: event,
				reason,
				aborted,
				willRetry,
				fromExtension,
				...(errorMessage === undefined ? {} : { errorMessage }),
			};
		}
		case "session_shutdown": {
			const { reason, targetSessionFile } = payload;
			if (!isOneOf(reason, SHUTDOWN_REASONS) || !isOptional(targetSessionFile, isString)) throw malformed(event);
			return { type: event, reason, ...(targetSessionFile === undefined ? {} : { targetSessionFile }) };
		}
		default:
			return undefined;
	}
}

function sessionCompactOf(payload: Record<string, unknown>): SessionCompactEvent {
	const { reason, requestId, accepted, compactionEntry, rejectionCause, fromExtension, willRetry } = payload;
	if (!isOneOf(reason, COMPACTION_REASONS) || typeof requestId !== "string") throw malformed("session_compact");
	const base = { type: "session_compact" as const, reason, requestId };
	if (
		accepted === true &&
		isCompactionEntry(compactionEntry) &&
		typeof fromExtension === "boolean" &&
		typeof willRetry === "boolean"
	)
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
