/**
 * The bounded field schemas every inbound record schema is built from (senpi#4324): ids, paths, text and secrets by
 * length, counts as non-negative integers, lists and free-form records by size. The host's own limits are reused
 * where it has them; the rest are named in `RPC_INBOUND_LIMITS`.
 */

import Type, { type TLiteral, type TProperties } from "typebox";
import { MAX_RPC_MESSAGE_CHARACTERS, SESSION_CONTEXT_LIMITS } from "./rpc-input-validation.ts";

/** Bounds on a question answer map (`extension_ui_response`, `extension_ui_progress`) from a validated caller. */
export const RPC_QUESTION_ANSWER_LIMITS = {
	answers: 64,
	selectedPerAnswer: 64,
	labelCharacters: MAX_RPC_MESSAGE_CHARACTERS,
} as const;

/**
 * Bounds every field of a validated caller's record stays inside, so a record from someone other than the local
 * user cannot carry a megabyte id, a negative count or a fifty-thousand-key patch.
 */
export const RPC_INBOUND_LIMITS = {
	/** ids, session and effect ids, provider and model names, other identifiers */
	identifierCharacters: 512,
	/** host paths: session files, working directories, export and import paths */
	pathCharacters: 4096,
	/** free text: prompts, commands, edits, instructions (the host's own message limit) */
	textCharacters: MAX_RPC_MESSAGE_CHARACTERS,
	/** credentials (API keys) */
	secretCharacters: 16_384,
	/** lists of ids, model entries, capabilities, delivery ids */
	listItems: 1024,
	/** images in one prompt, steer or follow-up */
	images: 64,
	/** keys in a free-form record (a context patch, bash operations, fallback chains) */
	recordKeys: 256,
	/** the largest count, revision, sequence or index (JSON numbers stay exact below it) */
	count: Number.MAX_SAFE_INTEGER,
	/** `open_session.env` entries; the host refuses more (`session-caller-env.ts`) */
	envEntries: 16,
	/** one `open_session.env` value; the host refuses a longer one (`session-caller-env.ts`) */
	envValueCharacters: 4096,
} as const;

/** An environment variable name the host accepts on `open_session.env` (`session-caller-env.ts`). */
const ENV_NAME_PATTERN = "^[A-Z_][A-Z0-9_]*$";

export const Str = Type.String({ maxLength: RPC_INBOUND_LIMITS.textCharacters });
export const Id = Type.String({ maxLength: RPC_INBOUND_LIMITS.identifierCharacters });
export const PathStr = Type.String({ maxLength: RPC_INBOUND_LIMITS.pathCharacters });
export const Secret = Type.String({ maxLength: RPC_INBOUND_LIMITS.secretCharacters });
/** Counts, revisions, sequences, indexes, sizes and durations: non-negative integers. */
export const Num = Type.Integer({ minimum: 0, maximum: RPC_INBOUND_LIMITS.count });
export const Bool = Type.Boolean();
export const Opt = Type.Optional;
export const Strings = Type.Array(Id, { maxItems: RPC_INBOUND_LIMITS.listItems });
export const OptStr = Opt(Str);
export const OptId = Opt(Id);
export const OptPath = Opt(PathStr);
export const OptNum = Opt(Num);
export const OptBool = Opt(Bool);
export const literals = <const L extends readonly [string, ...string[]]>(...values: L) =>
	Type.Union(values.map((value) => Type.Literal(value)) as unknown as { -readonly [I in keyof L]: TLiteral<L[I]> });

export const ThinkingLevel = literals("off", "minimal", "low", "medium", "high", "xhigh", "max");
export const SessionKind = literals("interactive", "worker");
export const SessionContext = Type.Record(Id, Str, { maxProperties: SESSION_CONTEXT_LIMITS.keys });
export const SessionEnv = Type.Record(
	Type.String({ pattern: ENV_NAME_PATTERN }),
	Type.String({ maxLength: RPC_INBOUND_LIMITS.envValueCharacters }),
	{ maxProperties: RPC_INBOUND_LIMITS.envEntries, additionalProperties: false },
);
// Image data is bounded by the record's line limit; the count of images is bounded where they are listed.
const ImageContent = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Id });
export const Images = Type.Array(ImageContent, { maxItems: RPC_INBOUND_LIMITS.images });
const ModelEntry = Type.Object({
	model: Type.Unknown(),
	thinkingLevel: Opt(ThinkingLevel),
	thinkingSelection: Opt(Type.Unknown()),
	serviceTier: Opt(Type.Unknown()),
});
export const ModelEntries = Type.Array(ModelEntry, { maxItems: RPC_INBOUND_LIMITS.listItems });
export const RetryFallback = Type.Object({
	modelFallback: Bool,
	fallbackChains: Type.Record(Id, Type.Immutable(Strings), { maxProperties: RPC_INBOUND_LIMITS.recordKeys }),
});
export const QuestionAnswers = Type.Record(
	Id,
	Type.Object({
		selected: Type.Array(Type.String({ maxLength: RPC_QUESTION_ANSWER_LIMITS.labelCharacters }), {
			maxItems: RPC_QUESTION_ANSWER_LIMITS.selectedPerAnswer,
		}),
		text: OptStr,
	}),
	{ maxProperties: RPC_QUESTION_ANSWER_LIMITS.answers },
);

/**
 * A host-level record: `id`, the compact caller's `admissionId` routing envelope (S15a-1, senpi#4272) and its own
 * fields. A record whose own fields require `admissionId` (`cancel_attempt`, `reset_stream`) overrides the envelope.
 */
export const command = <const T extends string, const P extends TProperties>(type: T, properties: P) =>
	Type.Object({ id: OptId, admissionId: OptId, type: Type.Literal(type), ...properties });

/** A session record: every one accepts the routing envelope's `sessionId`. */
export const session = <const T extends string, const P extends TProperties>(type: T, properties: P) =>
	command(type, { sessionId: OptId, ...properties });

/**
 * A session record whose own fields require `admissionId` (the recovery and admission commands, senpi#4272): the
 * optional envelope `command` adds would widen that field, so these are built without it.
 */
export const admissionSession = <const T extends string, const P extends TProperties>(type: T, properties: P) =>
	Type.Object({ id: OptId, type: Type.Literal(type), sessionId: OptId, ...properties });
