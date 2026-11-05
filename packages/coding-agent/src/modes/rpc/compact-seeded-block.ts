import {
	type AssistantMessage,
	type AssistantProgress,
	SeedFrontierError,
	seedNextOffset,
} from "@earendil-works/pi-ai";
import type { SeededJsonMessageUpdateEvent } from "../json-event.ts";
import { type ActiveBlock, appendBlock, deltaBlock } from "./compact-active-block.ts";
import { type CompactSeededDraft, type SeededFields } from "./compact-seeded-draft.ts";
import type { FrozenBlock } from "./compact-text-view.ts";
import { CompactTransitionError } from "./compact-transition.ts";

type PublicBlock = AssistantMessage["content"][number];
export type SeededBlockEvent =
	| Extract<SeededJsonMessageUpdateEvent["assistantMessageEvent"], { contentIndex: number }>
	| AssistantProgress;
export interface SeededBlock {
	readonly type: PublicBlock["type"];
	readonly fields: SeededFields;
	readonly body: ActiveBlock;
	readonly signature: ActiveBlock;
	/** `initial`: a slot from a message start's content, taken over by that index's own block start. */
	readonly phase: "initial" | "open" | "ended";
	readonly parsedThrough: number;
}
type Frontier = {
	readonly coveredCodeUnits: number;
	readonly nextOffset: number;
	readonly rawArgumentPrefix?: string;
	readonly parsedThrough?: number;
};

function parseFrontier(next: number, length: number, previous = 0): void {
	if (!Number.isSafeInteger(next) || next < previous || next > length)
		throw new CompactTransitionError("invalid_parse_frontier", `${next} outside [${previous}, ${length}]`);
}

/** The producer's frontier helper stays the single rule; its rejection joins the reducer's typed set. */
function seedOffset(next: number, length: number): number {
	try {
		return seedNextOffset(next, length);
	} catch (error) {
		if (error instanceof SeedFrontierError) throw new CompactTransitionError("invalid_seed_frontier", error.code);
		throw error;
	}
}

export function seedBlock(draft: CompactSeededDraft, block: PublicBlock, frontier?: Frontier): SeededBlock {
	const text =
		block.type === "text"
			? block.text
			: block.type === "thinking"
				? block.thinking
				: (frontier?.rawArgumentPrefix ?? "");
	const nextOffset = frontier ? seedOffset(frontier.nextOffset, text.length) : text.length;
	const covered = frontier?.coveredCodeUnits ?? 0;
	if (
		!Number.isSafeInteger(covered) ||
		(covered !== 0 && covered !== text.length) ||
		(covered === 0 && nextOffset !== text.length)
	)
		throw new CompactTransitionError("invalid_coverage", `${covered} of ${text.length}`);
	const parsedThrough = frontier?.parsedThrough ?? 0;
	parseFrontier(parsedThrough, text.length);
	const fields = Object.fromEntries(
		Object.entries(block)
			.filter(([key]) => key !== "text" && key !== "thinking")
			.map(([key, value]) => [key, key === "thinkingSignature" || key === "textSignature" ? "" : value]),
	);
	const body = draft.text(
		block.type === "thinking" ? "thinking" : block.type === "toolCall" ? "tool_arguments" : "text",
		text,
	);
	body.emitted = nextOffset;
	body.covered = covered;
	body.witness = nextOffset < covered ? text : "";
	const signature =
		block.type === "text" ? block.textSignature : block.type === "thinking" ? block.thinkingSignature : undefined;
	return {
		type: block.type,
		fields: draft.fields(fields),
		body,
		signature: draft.text("text", signature ?? ""),
		phase: "open",
		parsedThrough,
	};
}

/** Validation and candidate ownership precede the session owner's single publication. */
export function foldSeededBlock(
	draft: CompactSeededDraft,
	old: SeededBlock | undefined,
	event: SeededBlockEvent,
): SeededBlock {
	switch (event.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			if (old && old.phase !== "initial")
				throw new CompactTransitionError("duplicate_block", `${event.contentIndex}`);
			return seedBlock(draft, event.seed.block, event.seed);
		case "message_block_state":
			// A native insert installs a new block, like a seeded start (both may take over a start-content slot);
			// only its end replaces an open block.
			if (event.phase !== "insert") break;
			if (old && old.phase !== "initial")
				throw new CompactTransitionError("duplicate_block", `${event.contentIndex}`);
			return seedBlock(draft, event.block);
	}
	if (!old) throw new CompactTransitionError("unknown_block", `${event.contentIndex}`);
	if (old.phase !== "open") throw new CompactTransitionError("invalid_phase", old.phase);
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta": {
			const kind = event.type === "text_delta" ? "text" : event.type === "thinking_delta" ? "thinking" : "toolCall";
			if (old.type !== kind) throw new CompactTransitionError("wrong_kind", `${old.type} / ${kind}`);
			const parsedThrough = event.type === "toolcall_delta" ? event.parsedThrough : 0;
			parseFrontier(parsedThrough, Math.max(old.body.units, event.offset + event.delta.length), old.parsedThrough);
			const body = draft.clone(old.body);
			deltaBlock(draft.store, body, event.offset, event.delta);
			return { ...old, body, parsedThrough };
		}
		case "message_tool_arguments_reset":
			if (old.type !== "toolCall") throw new CompactTransitionError("wrong_kind", old.type);
			parseFrontier(event.parsedThrough, event.rawArgumentPrefix.length);
			return {
				...old,
				body: draft.text("tool_arguments", event.rawArgumentPrefix),
				parsedThrough: event.parsedThrough,
			};
		case "message_block_metadata": {
			const {
				type: _type,
				contentIndex: _index,
				thinkingSignatureDelta,
				thinkingSignature,
				textSignature,
				...fields
			} = event;
			if ((thinkingSignatureDelta !== undefined || thinkingSignature !== undefined) && old.type !== "thinking")
				throw new CompactTransitionError("wrong_kind", old.type);
			if (textSignature !== undefined && old.type !== "text")
				throw new CompactTransitionError("wrong_kind", old.type);
			const replacement = thinkingSignature ?? textSignature;
			const signature = replacement === undefined ? draft.clone(old.signature) : draft.text("text", replacement);
			if (thinkingSignatureDelta !== undefined) appendBlock(draft.store, signature, thinkingSignatureDelta);
			return {
				...old,
				signature,
				fields: draft.fields(
					{
						...fields,
						...(thinkingSignature !== undefined || thinkingSignatureDelta !== undefined
							? { thinkingSignature: "" }
							: {}),
						...(textSignature !== undefined ? { textSignature: "" } : {}),
					},
					old.fields,
				),
			};
		}
		case "message_block_state":
		case "text_end":
		case "thinking_end": {
			const kind =
				event.type === "message_block_state" ? event.block.type : event.type === "text_end" ? "text" : "thinking";
			if (old.type !== kind) throw new CompactTransitionError("wrong_kind", `${old.type} / ${kind}`);
			return { ...seedBlock(draft, event.block), phase: "ended" };
		}
		case "toolcall_end":
			if (old.type !== "toolCall") throw new CompactTransitionError("wrong_kind", old.type);
			return { ...old, fields: draft.fields(event.toolCall), phase: "ended" };
	}
}

function frozenSeededBlock(block: SeededBlock) {
	return {
		type: block.type,
		fields: block.fields,
		phase: block.phase,
		parsedThrough: block.parsedThrough,
		signature: { root: block.signature.root, tailRoot: block.signature.tailRoot },
	};
}
export type FrozenSeededBlock = ReturnType<typeof frozenSeededBlock>;
/** The published component row of one active block, seeded or legacy. */
export function frozenBlock(contentIndex: number, block: ActiveBlock): FrozenBlock {
	return {
		contentIndex,
		kind: block.kind,
		root: block.root,
		tail: "",
		tailRoot: block.tailRoot,
		...(block.seeded ? { seeded: frozenSeededBlock(block.seeded) } : {}),
	};
}
export function seededBlockLeaves(block: FrozenSeededBlock): readonly number[] {
	return [block.signature.root, block.signature.tailRoot, ...Object.values(block.fields).map((ref) => ref.owner)];
}
