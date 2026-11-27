import type { SeededJsonAgentSessionEvent, SeededJsonMessageUpdateEvent } from "../json-event.ts";
import type { ActiveBlock } from "./compact-active-block.ts";
import type { CompactComponentRoots, ComponentRoot } from "./compact-component-roots.ts";
import type { CompactContentIndex } from "./compact-content-index.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import { frozenBlock, type SeededBlock, seedBlock } from "./compact-seeded-block.ts";
import { CompactSeededDraft, type SeededFields } from "./compact-seeded-draft.ts";
import type { SettledRow } from "./compact-state-view.ts";
import type { FrozenBlock } from "./compact-text-view.ts";
import { CompactTransitionError } from "./compact-transition.ts";

type Nested = Extract<SeededJsonMessageUpdateEvent["assistantMessageEvent"], { type: "start" | "done" | "error" }>;
export type SeededMessage = Extract<SeededJsonAgentSessionEvent, { type: "message_start" }>["message"];
/** The message-level records: outer start and end, and the nested start and terminals of an assistant stream. */
export type SeededMessageRecord =
	| Extract<SeededJsonAgentSessionEvent, { type: "message_start" | "message_end" }>
	| (Omit<SeededJsonMessageUpdateEvent, "assistantMessageEvent"> & { readonly assistantMessageEvent: Nested });
interface TerminalCut {
	readonly invalidatedBlocks?: readonly number[];
	readonly rewrittenFrom?: number;
}

export function recordMessage(record: SeededMessageRecord): { message: SeededMessage; terminal: boolean } {
	if (record.type !== "message_update") return { message: record.message, terminal: record.type === "message_end" };
	const event = record.assistantMessageEvent;
	switch (event.type) {
		case "start":
			return { message: event.seed.message, terminal: false };
		case "done":
			return { message: event.message, terminal: true };
		case "error":
			return { message: event.error, terminal: true };
	}
}

/**
 * The whole public message wins: a terminal rebuilds every block from its content, so no index it no longer names
 * survives. Raw tool spelling is kept only from an ENDED block below the producer's cutoff and not invalidated, so an
 * abandoned stream's partial raw text and preview never outlive the terminal.
 */
export function seedMessage(
	draft: CompactSeededDraft,
	message: SeededMessage,
	terminal: boolean,
	previous?: ReadonlyMap<number, ActiveBlock>,
	cut: TerminalCut = {},
): { fields: SeededFields; blocks: Map<number, SeededBlock> } {
	const blocks = new Map<number, SeededBlock>();
	const { invalidatedBlocks = [], rewrittenFrom = Number.POSITIVE_INFINITY } = cut;
	if (
		rewrittenFrom < 0 ||
		(rewrittenFrom !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(rewrittenFrom)) ||
		invalidatedBlocks.some((index) => !Number.isSafeInteger(index) || index < 0)
	)
		throw new CompactTransitionError("invalid_terminal", `rewrittenFrom ${rewrittenFrom}`);
	if (message.role !== "assistant") return { fields: draft.fields(message), blocks };
	const invalidated = new Set(invalidatedBlocks);
	const { content, ...metadata } = message;
	for (const [index, publicBlock] of content.entries()) {
		const block = seedBlock(draft, publicBlock);
		const old = previous?.get(index)?.seeded;
		const raw =
			terminal &&
			block.type === "toolCall" &&
			old?.type === "toolCall" &&
			old.phase === "ended" &&
			index < rewrittenFrom &&
			!invalidated.has(index);
		blocks.set(index, {
			...block,
			...(raw ? { body: { ...draft.clone(old.body), witness: "" }, parsedThrough: old.parsedThrough } : {}),
			phase: terminal ? "ended" : "initial",
		});
	}
	return { fields: draft.fields(metadata), blocks };
}

/** An indexed record's usage and changed metadata fold into the message's own fields in the same step. */
export function updateFields(
	draft: CompactSeededDraft,
	fields: SeededFields | undefined,
	update: Partial<Pick<SeededJsonMessageUpdateEvent, "usage" | "messageMetadata">>,
): SeededFields | undefined {
	if (update.usage === undefined && update.messageMetadata === undefined) return fields;
	const changed = { ...update.messageMetadata, ...(update.usage === undefined ? {} : { usage: update.usage }) };
	return draft.fields(changed, fields, true);
}

/** The cold edit/install step: a settled row replaced whole from an authoritative message, never a partial patch. */
export function installSettledMessage(
	owner: {
		readonly store: CompactContentStore;
		readonly blockRoots: CompactComponentRoots<FrozenBlock>;
		readonly settled: CompactContentIndex<SettledRow>;
	},
	messageId: string,
	message: SeededMessage,
	keep: Pick<SettledRow, "persistence" | "correlation">,
): void {
	using draft = new CompactSeededDraft(owner.store);
	const { fields, blocks } = seedMessage(draft, message, true);
	let root: ComponentRoot<FrozenBlock> = { header: undefined, ref: undefined };
	for (const [index, block] of blocks)
		root = owner.blockRoots.set(
			root,
			String(index).padStart(16, "0"),
			frozenBlock(index, { ...block.body, seeded: block }),
		);
	owner.settled.set(messageId, {
		messageId,
		persistence: keep.persistence,
		fields,
		...(root.ref ? { blocks: root.ref } : {}),
		...(keep.correlation ? { correlation: keep.correlation } : {}),
	});
	owner.blockRoots.release(root);
}
