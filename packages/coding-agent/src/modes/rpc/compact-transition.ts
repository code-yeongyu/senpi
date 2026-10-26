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

export type CompactTransition =
	| (BlockAddress & {
			readonly type: "block_start";
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
	| { readonly type: "message_remove"; readonly messageId: string };

type CompactRejection =
	| "unknown_block"
	| "duplicate_block"
	| "invalid_coverage"
	| "non_contiguous"
	| "conflicting_overlap"
	| "unknown_message";

export class CompactTransitionError extends Error {
	readonly reason: CompactRejection;

	constructor(reason: CompactRejection, detail: string) {
		super(`compact transition rejected (${reason}): ${detail}`);
		this.name = "CompactTransitionError";
		this.reason = reason;
	}
}
