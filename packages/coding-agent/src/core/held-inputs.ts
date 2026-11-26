import type { ImageContent } from "@earendil-works/pi-ai";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionEntry } from "./session-manager.ts";

export const HELD_INPUT_ENTRY = "held-input";
export const HELD_INPUT_WITHDRAWN_ENTRY = "held-input-withdrawn";
export const HELD_INPUTS_CONSUMED_ENTRY = "held-inputs-consumed";

export interface HeldInput {
	readonly inputId: string;
	readonly revision: number;
	readonly text: string;
	readonly images?: ImageContent[];
	/** A person's input held before preparation: its commands, skills and templates run when it is delivered. */
	readonly prepare?: true;
	readonly entryId: string;
}

export type HoldInputResult =
	| { readonly kind: "held"; readonly entryId: string; readonly duplicate: boolean }
	| { readonly kind: "already_delivered"; readonly revision: number }
	| { readonly kind: "input_id_conflict"; readonly heldRevision: number };

/** The held-input entries of the whole history, read without keeping a full-history view (senpi#2537). */
export const heldInputHistory: HistoryReducer<SessionEntry[]> = {
	initial: () => [],
	add: (entries, entry) => {
		if (
			entry.type === "custom" &&
			(entry.customType === HELD_INPUT_ENTRY ||
				entry.customType === HELD_INPUT_WITHDRAWN_ENTRY ||
				entry.customType === HELD_INPUTS_CONSUMED_ENTRY)
		)
			entries.push(entry);
		return entries;
	},
};

type HeldInputData = { inputId: string; revision: number; text: string; images?: ImageContent[]; prepare?: true };
type SettledInput = { inputId: string; revision: number };

function isHeldInputData(value: unknown): value is HeldInputData {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return (
		typeof data.inputId === "string" &&
		typeof data.revision === "number" &&
		typeof data.text === "string" &&
		(data.prepare === undefined || data.prepare === true) &&
		(data.images === undefined || (Array.isArray(data.images) && data.images.every(isImageContent)))
	);
}

function isImageContent(value: unknown): value is ImageContent {
	if (typeof value !== "object" || value === null) return false;
	const part = value as Record<string, unknown>;
	return part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string";
}

function settledOf(value: unknown): SettledInput[] {
	if (typeof value !== "object" || value === null) return [];
	const inputs = (value as { inputs?: unknown }).inputs;
	if (!Array.isArray(inputs)) return [];
	return inputs.filter(
		(input): input is SettledInput =>
			typeof input === "object" &&
			input !== null &&
			typeof input.inputId === "string" &&
			typeof input.revision === "number",
	);
}

/**
 * Human input stored while a run-owned hold keeps it from starting a turn (senpi#3811). Idempotent by
 * input id: the same id and revision is one entry, the same id with another revision is refused, so a
 * guidance record replayed after a crash is never delivered twice and never silently replaced.
 */
export class HeldInputs {
	private readonly inputs = new Map<string, HeldInput>();
	private readonly settled = new Map<string, number>();
	private readonly append: (customType: string, data: unknown) => string;

	constructor(entries: readonly SessionEntry[], append: (customType: string, data: unknown) => string) {
		this.append = append;
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === HELD_INPUT_ENTRY && isHeldInputData(entry.data)) {
				this.inputs.set(entry.data.inputId, { ...entry.data, entryId: entry.id });
			} else if (
				entry.customType === HELD_INPUT_WITHDRAWN_ENTRY ||
				entry.customType === HELD_INPUTS_CONSUMED_ENTRY
			) {
				for (const input of settledOf(entry.data)) this.settle(input);
			}
		}
	}

	hold(input: HeldInputData): HoldInputResult {
		const existing = this.inputs.get(input.inputId);
		if (existing !== undefined) {
			if (existing.revision !== input.revision)
				return { kind: "input_id_conflict", heldRevision: existing.revision };
			return { kind: "held", entryId: existing.entryId, duplicate: true };
		}
		const settledRevision = this.settled.get(input.inputId);
		if (settledRevision === input.revision) return { kind: "already_delivered", revision: settledRevision };
		if (settledRevision !== undefined) return { kind: "input_id_conflict", heldRevision: settledRevision };
		const entryId = this.append(HELD_INPUT_ENTRY, input);
		this.inputs.set(input.inputId, { ...input, entryId });
		return { kind: "held", entryId, duplicate: false };
	}

	withdraw(inputId: string): boolean {
		const input = this.inputs.get(inputId);
		if (input === undefined) return false;
		const settled = { inputId, revision: input.revision };
		this.append(HELD_INPUT_WITHDRAWN_ENTRY, { inputs: [settled] });
		this.settle(settled);
		return true;
	}

	pending(): HeldInput[] {
		return [...this.inputs.values()];
	}

	consume(inputIds: readonly string[]): void {
		const held = inputIds.flatMap((id) => {
			const input = this.inputs.get(id);
			return input === undefined ? [] : [{ inputId: id, revision: input.revision }];
		});
		if (held.length === 0) return;
		this.append(HELD_INPUTS_CONSUMED_ENTRY, { inputs: held });
		for (const settled of held) this.settle(settled);
	}

	private settle(input: SettledInput): void {
		this.inputs.delete(input.inputId);
		this.settled.set(input.inputId, input.revision);
	}
}
