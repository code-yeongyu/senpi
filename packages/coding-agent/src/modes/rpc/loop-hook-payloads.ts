import type { ImageContent } from "@earendil-works/pi-ai";
import type { ForwardedLoopEvent } from "../../core/extensions/event-placement.ts";
import type { ExtensionRunner } from "../../core/extensions/runner.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { CarriedSession, LoopHookCallBinding } from "./loop-hook-call.ts";
import type { MessageStreams } from "./loop-hook-message-stream.ts";
import { isCustomEntry, isSessionEntry } from "./session-entry-schema.ts";

// The hand's boundary for the loop events a hosted loop forwards (senpi#5898): each payload is parsed by its event
// family's module into the event its handlers see in a session, or refused as malformed; nothing past the parse
// re-checks a payload. This module holds what every family shares; the transcript schemas live in `*-schema.ts`.

/** What a forwarded event's handlers run with on the hand. */
export interface LoopHookDispatch {
	readonly runner: ExtensionRunner;
	/** The user's loop hooks (provenance-filtered); a builtin is the loop's own machinery and runs there. */
	readonly only: (extensionPath: string) => boolean;
	/** The call's own signal: aborted when the loop cancels the call or the call ends. */
	readonly signal: AbortSignal;
}

/**
 * One forwarded event, parsed: the emit that runs its handlers and merges their result, and what its call binds beyond
 * the session's id and idle state: the session port's read half it carries (what it proves about the loop's turn is
 * `TURN_EVIDENCE`'s, in `loopless-loop-hooks.ts`).
 */
export interface ParsedLoopHook {
	readonly binding?: Pick<LoopHookCallBinding, "carried">;
	readonly emit: (dispatch: LoopHookDispatch) => Promise<object | undefined>;
}

/** What a parser reads beyond its payload: this machine's workspace, the loop session, and its held stream. */
export interface LoopHookParseContext {
	readonly cwd: string;
	readonly sessionId: string;
	readonly streams: MessageStreams;
}

/** Parses one event's payload. Throws when the payload is malformed. */
export type LoopHookParser = (payload: Record<string, unknown>, context: LoopHookParseContext) => ParsedLoopHook;

/** The parsers of one event family, each typed as a `LoopHookParser`, keyed by the forwarded events it owns. */
export const loopHookFamily = <E extends ForwardedLoopEvent>(
	parsers: Record<E, LoopHookParser>,
): Record<E, LoopHookParser> => parsers;

/**
 * An event the runner's forwarded emit runs: a notification, whose effects ride the reply, or a `session_before_*`
 * interceptor, whose result it merges as a session's emit does (the last result; the first `cancel` ends the walk).
 */
export const forwarded = (event: Parameters<ExtensionRunner["emitForwardedLoopEvent"]>[0]): ParsedLoopHook => ({
	emit: ({ runner, only }) => runner.emitForwardedLoopEvent(event, only),
});

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
	typeof value === "string" && (allowed as readonly string[]).includes(value);

export const isString = (value: unknown): value is string => typeof value === "string";
export const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isOptional = <T>(value: unknown, is: (value: unknown) => value is T): value is T | undefined =>
	value === undefined || is(value);
export const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
export const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
export const isSessionEntries = (value: unknown): value is SessionEntry[] =>
	Array.isArray(value) && value.every(isSessionEntry);

export const malformed = (event: string): Error => new Error(`malformed ${event} payload`);

/** The images of a loop event, `undefined` when it has none, `null` when they are malformed. */
export const imagesOf = (value: unknown): ImageContent[] | undefined | null =>
	value === undefined ? undefined : Array.isArray(value) && value.every(isImage) ? value : null;

const isImage = (value: unknown): value is ImageContent =>
	isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";

/**
 * The session port's read half a call carries (`leafId`, `handEntries`; see `CarriedSession`), or `null` when
 * malformed. Each hand entry is a custom entry: the hand only ever authored custom entries.
 */
export function carriedSessionOf(payload: Record<string, unknown>): CarriedSession | null {
	const { leafId, handEntries } = payload;
	if (!isNullableString(leafId)) return null;
	if (!Array.isArray(handEntries) || !handEntries.every(isCustomEntry)) return null;
	return { leafId, handEntries };
}
