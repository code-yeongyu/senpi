import type { HistoryReducer } from "../../../session-history-reduce.ts";
import {
	createRepetitiveTurnsState,
	isNearDuplicateOfPreviousTurn,
	normalizeTurnText,
	REPETITIVE_TURNS_MIN_NORMALIZED_CHARS,
	REPETITIVE_TURNS_RULE_NAME,
	type RepetitiveTurnsState,
	recordTurnText,
} from "./detectors/repetitive-turns.ts";

export function collectAssistantText(message: { readonly content: unknown }): string | null {
	if (!Array.isArray(message.content)) return null;
	let combined = "";
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		const value: unknown = Reflect.get(block, "text");
		if (typeof value === "string") combined += value;
	}
	return combined.length > 0 ? combined : null;
}

const RESTORED_TURN_LIMIT = 8;

/**
 * The last assistant texts of a session's history, which the cross-turn lane restores from. Folded, so a rebuilt
 * extension reads only the entries appended since instead of the whole history (senpi#7607).
 */
export const persistedAssistantTexts: HistoryReducer<string[]> = {
	initial: () => [],
	add: (texts, entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return texts;
		const text = collectAssistantText(entry.message);
		if (text === null) return texts;
		texts.push(text);
		if (texts.length > RESTORED_TURN_LIMIT) texts.shift();
		return texts;
	},
};

export class RepetitiveTurnsLane {
	#state: RepetitiveTurnsState = createRepetitiveTurnsState();
	#armed = false;
	#recovering = false;
	#currentTurnText = "";
	#lastCompletedTurnText: string | null = null;
	#enabled = true;

	configure(disabledRules: ReadonlySet<string>): void {
		this.#enabled = !disabledRules.has(REPETITIVE_TURNS_RULE_NAME);
	}

	resetSession(): void {
		this.#state = createRepetitiveTurnsState();
		this.#armed = false;
		this.#recovering = false;
		this.#currentTurnText = "";
		this.#lastCompletedTurnText = null;
	}

	restoreFromHistory(assistantTexts: readonly string[]): void {
		for (const text of assistantTexts) {
			this.recordCompletedTurn(text);
		}
		this.#armed = false;
	}

	resetTurn(): void {
		this.#armed = false;
		this.#currentTurnText = "";
	}

	disarm(): void {
		this.#armed = false;
	}

	get armed(): boolean {
		return this.#armed;
	}

	observeTextDelta(delta: string, canArm: boolean): boolean {
		if (this.#enabled && !this.#armed && !this.#recovering && canArm && this.#lastCompletedTurnText !== null) {
			const candidate = normalizeTurnText(this.#currentTurnText + delta);
			if (
				candidate.length >= REPETITIVE_TURNS_MIN_NORMALIZED_CHARS &&
				isNearDuplicateOfPreviousTurn(candidate, this.#lastCompletedTurnText)
			) {
				this.#armed = true;
			}
		}
		this.#currentTurnText += delta;
		return this.#armed;
	}

	commitArmedTurn(turnText: string | null): void {
		this.#armed = false;
		this.#recovering = true;
		if (turnText !== null) {
			this.#lastCompletedTurnText = normalizeTurnText(turnText);
		}
	}

	recordCompletedTurn(turnText: string): void {
		const normalized = normalizeTurnText(turnText);
		this.#lastCompletedTurnText = normalized;
		if (!this.#enabled) return;
		const match = recordTurnText(this.#state, turnText);
		if (match === null) {
			if (this.#recovering) this.#recovering = false;
			return;
		}
		this.#armed = true;
	}
}
