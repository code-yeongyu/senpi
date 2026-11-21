import {
	isNearDuplicateOfPreviousTurn,
	normalizeTurnText,
	REPETITIVE_TURNS_MIN_NORMALIZED_CHARS,
	REPETITIVE_TURNS_RULE_NAME,
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

/** Whether an assistant message called a tool: the agent acted instead of only reporting (senpi#4537). */
export function hasToolCall(message: { readonly content: unknown }): boolean {
	if (!Array.isArray(message.content)) return false;
	return message.content.some(
		(block: unknown) => typeof block === "object" && block !== null && "type" in block && block.type === "toolCall",
	);
}

const RESTORED_TURN_LIMIT = 8;

interface SessionEntrySource {
	readonly sessionManager: { getEntries(): readonly unknown[] };
}

/** The text-only replies since the agent last called a tool, the window the lane compares within. */
export function readPersistedAssistantTexts(ctx: SessionEntrySource): string[] {
	let texts: string[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (typeof entry !== "object" || entry === null) continue;
		if (!("type" in entry) || entry.type !== "message") continue;
		const message: unknown = Reflect.get(entry, "message");
		if (typeof message !== "object" || message === null) continue;
		if (Reflect.get(message, "role") !== "assistant") continue;
		const content: unknown = Reflect.get(message, "content");
		if (hasToolCall({ content })) {
			texts = [];
			continue;
		}
		const text = collectAssistantText({ content });
		if (text !== null) texts.push(text);
	}
	return texts.slice(-RESTORED_TURN_LIMIT);
}

/**
 * Compares each completed text-only reply with the previous one. The rule is for a model that repeats its status
 * instead of acting, so a reply that calls a tool resets the comparison: summaries separated by real work are
 * progress reports, however similar their format (senpi#4537). The verdict comes after the reply has completed;
 * the lane never cuts a reply off mid-stream.
 */
export class RepetitiveTurnsLane {
	#previous: string | null = null;
	#enabled = true;

	configure(disabledRules: ReadonlySet<string>): void {
		this.#enabled = !disabledRules.has(REPETITIVE_TURNS_RULE_NAME);
	}

	resetSession(): void {
		this.#previous = null;
	}

	restoreFromHistory(assistantTexts: readonly string[]): void {
		for (const text of assistantTexts) {
			this.#previous = normalizeTurnText(text);
		}
	}

	noteToolWork(): void {
		this.#previous = null;
	}

	/** Records a completed text-only reply; true when it near-duplicates the previous one with no tool work between. */
	completeTurn(turnText: string): boolean {
		const candidate = normalizeTurnText(turnText);
		const previous = this.#previous;
		this.#previous = candidate;
		if (!this.#enabled || previous === null) return false;
		return (
			candidate.length >= REPETITIVE_TURNS_MIN_NORMALIZED_CHARS && isNearDuplicateOfPreviousTurn(candidate, previous)
		);
	}
}
