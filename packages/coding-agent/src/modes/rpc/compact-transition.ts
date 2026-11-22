import type { SeededJsonMessageUpdateEvent } from "../json-event.ts";
import type { SeededBlockEvent } from "./compact-seeded-block.ts";
import type { SeededMessageRecord } from "./compact-seeded-messages.ts";

/**
 * The typed transitions compact current state accepts (senpi#4272, R3.C6.4) and the typed
 * rejection `CompactSessionState.accept` throws when one fails validation.
 */

export type CompactBlockKind = "text" | "thinking" | "tool_arguments";
export type CompactPersistence = "pending" | "appended" | "failed";

export interface BlockAddress {
	readonly messageId: string;
	readonly contentIndex: number;
}

interface SeededIdentity {
	readonly messageId: string;
	readonly epoch: string;
	readonly ordinal: number;
	readonly firstOrdinal: number;
}

export type CompactTransition =
	| (SeededIdentity & {
			readonly type: "seeded_block";
			readonly event: SeededBlockEvent;
			/** The enclosing record's message-level usage and changed metadata (`null` removes a field). */
			readonly usage?: SeededJsonMessageUpdateEvent["usage"];
			readonly messageMetadata?: SeededJsonMessageUpdateEvent["messageMetadata"];
			/** The record's own client correlation and resolved tool name, read by the calls component (S06). */
			readonly correlation?: object;
			readonly resolvedToolName?: string;
	  })
	| (SeededIdentity & {
			readonly type: "seeded_message";
			readonly record: SeededMessageRecord;
			/** Bound once when the message is created; later records never rewrite it. */
			readonly correlation?: object;
			/** Producer terminal cutoffs: these indexes, and every index at or above `rewrittenFrom`, lose raw spelling. */
			readonly invalidatedBlocks?: readonly number[];
			readonly rewrittenFrom?: number;
	  })
	| (BlockAddress & {
			readonly type: "block_start";
			readonly epoch: string;
			readonly ordinal: number;
			/** Producer-owned ordinal of this message's first block_start, stable across all its blocks. */
			readonly firstOrdinal: number;
			readonly kind: CompactBlockKind;
			readonly seed: string;
			/**
			 * The whole seed when later deltas replay it from offset 0, or 0 when they continue after it. Partial
			 * coverage is refused: the uncovered seed tail would make every later delta overlap or leave a gap.
			 */
			readonly coveredCodeUnits: number;
	  })
	| (BlockAddress & { readonly type: "block_delta"; readonly offset: number; readonly text: string })
	| (BlockAddress & { readonly type: "block_replace"; readonly text: string })
	| { readonly type: "message_status"; readonly messageId: string; readonly persistence: CompactPersistence }
	| { readonly type: "message_remove"; readonly messageId: string }
	/** A JSON-normal host-origin lifecycle, run-state or dialog record (`COMPONENT_RECORDS`). */
	| { readonly type: "component"; readonly record: object };

type CompactRejection =
	| "invalid_start_identity"
	| "duplicate_or_stale_start"
	| "unknown_block"
	| "duplicate_block"
	| "invalid_coverage"
	| "non_contiguous"
	| "conflicting_overlap"
	| "cold_operation_required"
	| "unknown_message"
	| "invalid_parse_frontier"
	| "invalid_seed_frontier"
	| "invalid_phase"
	| "wrong_kind"
	| "wrong_epoch"
	| "invalid_terminal";

export class CompactTransitionError extends Error {
	readonly reason: CompactRejection;

	constructor(reason: CompactRejection, detail: string) {
		super(`compact transition rejected (${reason}): ${detail}`);
		this.name = "CompactTransitionError";
		this.reason = reason;
	}
}
