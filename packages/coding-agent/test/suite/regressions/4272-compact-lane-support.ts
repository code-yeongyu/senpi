import { expect, vi } from "vitest";
import type { CompactTransition } from "../../../src/modes/rpc/compact-transition.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";

type Seeded = Extract<CompactTransition, { type: "seeded_block" | "seeded_message" }>;
export interface Fold {
	readonly t: Seeded;
	readonly sequence: number;
}

/** Records every production fold into a compact owner with the sequence it published at; behavior is unchanged. */
export function recordFolds(): Fold[] {
	const folds: Fold[] = [];
	const accept = CompactSessionState.prototype.accept;
	vi.spyOn(CompactSessionState.prototype, "accept").mockImplementation(function (
		this: CompactSessionState,
		...args: Parameters<CompactSessionState["accept"]>
	) {
		const sequence = accept.apply(this, args);
		const [t] = args;
		if (t.type === "seeded_block" || t.type === "seeded_message") folds.push({ t, sequence });
		return sequence;
	});
	return folds;
}

/**
 * RULING-36/40 and #4425 LOW 3: one strictly increasing producer numbering; a message is created by a message-level
 * record (its outer start, or a terminal when the start was uncaptured), never by an indexed block record.
 */
export function expectOneNumbering(folds: readonly Fold[], epoch: string): void {
	expect(folds.length).toBeGreaterThan(3);
	for (const [index, fold] of folds.entries()) {
		expect(fold.t.epoch).toBe(epoch);
		if (index > 0) {
			expect(fold.t.ordinal).toBeGreaterThan(folds[index - 1].t.ordinal);
			expect(fold.sequence).toBeGreaterThan(folds[index - 1].sequence);
		}
		const first = folds.find((other) => other.t.messageId === fold.t.messageId);
		expect(fold.t.firstOrdinal).toBe(first?.t.ordinal);
		expect(first?.t.type).toBe("seeded_message");
		if (fold.t.type === "seeded_block")
			expect(first?.t.type === "seeded_message" && first.t.record.type).toBe("message_start");
	}
}
