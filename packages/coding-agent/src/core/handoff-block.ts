/**
 * The agent's handoff block (`Ask: ... - wanted: ... For you: ... Now: ... Next: ...`, or the GPT presets'
 * `... You need: ... Now: ... Next: ...`) as a separable, typed part of an assistant reply (senpi#4077).
 *
 * The structure is derived from the reply text, never persisted: the session transcript keeps the text as
 * written, so a session recorded before this parser existed yields the same blocks. One parser serves every
 * reader: the TUI fold (senpi#3323), the JSON and RPC `message_end` records, and the ttsr repetitive-turns
 * detector. The labels stay English by prompt contract (`HANDOFF_LANGUAGE_RULE`), so they are matched
 * literally; the slot contents are any language.
 */

export type HandoffShape = "claude" | "gpt";

export interface HandoffBlock {
	/** `claude`: `Ask:` [`wanted:`] `For you:` `Now:` `Next:`; `gpt`: an outcome sentence, then `You need:` `Now:` `Next:`. */
	readonly shape: HandoffShape;
	/** The block exactly as written (one trimmed paragraph). */
	readonly block: string;
	readonly ask: string | undefined;
	readonly wanted: string | undefined;
	readonly forYou: string | undefined;
	/** GPT shape: the sentence before `You need:`. */
	readonly outcome: string | undefined;
	readonly youNeed: string | undefined;
	/**
	 * What the reader needs, kept as answer text when the block is folded: the `For you:` slot, or for the GPT
	 * shape the outcome followed by the `You need:` slot.
	 */
	readonly answer: string | undefined;
	readonly now: string | undefined;
	readonly next: string | undefined;
}

export type TextSegment = { readonly kind: "text"; readonly text: string };
export type HandoffSegment = { readonly kind: "handoff" } & HandoffBlock;
export type AssistantTextSegment = TextSegment | HandoffSegment;

/** A block found in an assistant message, with the index of the text part that holds it. */
export interface MessageHandoffBlock extends HandoffBlock {
	readonly contentIndex: number;
}

export interface SplitHandoffOptions {
	/**
	 * Also accept a Claude-shaped block that is not finished yet: it opens with `Ask:` and its labels so far
	 * are a prefix of the template that already reaches `For you:` or `Now:`. For readers of a stream still
	 * being written (the ttsr mid-stream lane); a renderer leaves it off so an unfinished block stays text.
	 */
	readonly allowIncomplete?: boolean;
}

const LABEL = /(?:\*{1,2})?\b(Ask|wanted|For you|You need|Now|Next)(?:\*{1,2})?\s*[:\uFF1A](?:\*{1,2})?/gu;
/**
 * The two label sequences the prompts produce, matched exactly so a paragraph that merely uses some of
 * these words ("You need: Node 22. Now: run install. Next: run tests.") stays prose.
 */
const CLAUDE_SHAPES = [
	["Ask", "wanted", "For you", "Now", "Next"],
	["Ask", "For you", "Now", "Next"],
] as const;
const GPT_SHAPE = "You need,Now,Next";
const INCOMPLETE_CLOSERS = new Set(["For you", "Now"]);

type LabelHit = { readonly label: string; readonly start: number; readonly end: number };

function labelsOf(paragraph: string): LabelHit[] {
	return [...paragraph.matchAll(LABEL)].map((match) => ({
		label: match[1] ?? "",
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
}

function slot(paragraph: string, hits: readonly LabelHit[], label: string): string | undefined {
	const at = hits.findIndex((hit) => hit.label === label);
	if (at < 0) return undefined;
	const start = hits[at]?.end ?? 0;
	const end = hits[at + 1]?.start ?? paragraph.length;
	const text = paragraph
		.slice(start, end)
		.trim()
		.replace(/\s+[-\u2013\u2014]$/u, "");
	return text === "" ? undefined : text;
}

function isClaudeShape(labels: readonly string[], allowIncomplete: boolean): boolean {
	return CLAUDE_SHAPES.some((shape) => {
		if (labels.length === shape.length) return labels.every((label, at) => label === shape[at]);
		if (!allowIncomplete || labels.length > shape.length) return false;
		return labels.every((label, at) => label === shape[at]) && labels.some((label) => INCOMPLETE_CLOSERS.has(label));
	});
}

function parseHandoff(paragraph: string, allowIncomplete: boolean): HandoffSegment | undefined {
	const hits = labelsOf(paragraph);
	const labels = hits.map((hit) => hit.label);
	const lead = paragraph.slice(0, hits[0]?.start ?? 0).trim();
	const common = {
		kind: "handoff",
		block: paragraph,
		now: slot(paragraph, hits, "Now"),
		next: slot(paragraph, hits, "Next"),
	} as const;
	if (isClaudeShape(labels, allowIncomplete)) {
		if (lead !== "") return undefined;
		const forYou = slot(paragraph, hits, "For you");
		return {
			...common,
			shape: "claude",
			ask: slot(paragraph, hits, "Ask"),
			wanted: slot(paragraph, hits, "wanted"),
			forYou,
			outcome: undefined,
			youNeed: undefined,
			answer: forYou,
		};
	}
	if (labels.join(",") !== GPT_SHAPE || lead === "") return undefined;
	const youNeed = slot(paragraph, hits, "You need");
	return {
		...common,
		shape: "gpt",
		ask: undefined,
		wanted: undefined,
		forYou: undefined,
		outcome: lead,
		youNeed,
		answer: youNeed === undefined ? lead : `${lead} ${youNeed}`,
	};
}

/**
 * Splits an assistant text into prose and handoff blocks. A block is one paragraph (blank-line separated)
 * whose labels are exactly `Ask:` [`wanted:`] `For you:` `Now:` `Next:` with nothing before `Ask:`, or an
 * outcome sentence followed by exactly `You need:` `Now:` `Next:`; a paragraph inside a code fence never
 * counts. Text with no block comes back as one text segment. Without `allowIncomplete`, a block still
 * streaming stays text until its `Next:` arrives.
 */
export function splitHandoffBlocks(text: string, options: SplitHandoffOptions = {}): readonly AssistantTextSegment[] {
	const allowIncomplete = options.allowIncomplete === true;
	const paragraphs = text.split(/\n[ \t]*\n/u);
	const segments: AssistantTextSegment[] = [];
	let prose: string[] = [];
	let inFence = false;
	const flush = () => {
		const joined = prose.join("\n\n").trim();
		if (joined !== "") segments.push({ kind: "text", text: joined });
		prose = [];
	};
	for (const paragraph of paragraphs) {
		const fences = paragraph.match(/^\s*(?:```|~~~)/gmu)?.length ?? 0;
		const handoff = !inFence && fences === 0 ? parseHandoff(paragraph.trim(), allowIncomplete) : undefined;
		if (fences % 2 === 1) inFence = !inFence;
		if (!handoff) {
			prose.push(paragraph);
			continue;
		}
		flush();
		segments.push(handoff);
	}
	flush();
	return segments;
}

/**
 * The finished handoff blocks of a message's visible text parts, in order. Empty for a message with no
 * block, for model-only text (`audience: "model"`), and for non-assistant messages.
 */
export function findHandoffBlocks(message: {
	readonly role: string;
	readonly content?: unknown;
}): readonly MessageHandoffBlock[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const blocks: MessageHandoffBlock[] = [];
	message.content.forEach((part: unknown, contentIndex) => {
		if (typeof part !== "object" || part === null) return;
		const text: unknown = Reflect.get(part, "text");
		if (Reflect.get(part, "type") !== "text" || typeof text !== "string") return;
		if (Reflect.get(part, "audience") === "model") return;
		for (const segment of splitHandoffBlocks(text.trim())) {
			if (segment.kind !== "handoff") continue;
			const { kind: _kind, ...block } = segment;
			blocks.push({ ...block, contentIndex });
		}
	});
	return blocks;
}

/**
 * Adds the derived `handoffs` field to an assistant `message_end` record that holds at least one block.
 * Every other record, including a `message_end` with no block, is returned as the same object, so its wire
 * bytes do not change.
 */
export function withHandoffs<T extends { readonly type: string }>(
	record: T,
): T | (T & { handoffs: readonly MessageHandoffBlock[] }) {
	if (record.type !== "message_end") return record;
	const message: unknown = Reflect.get(record, "message");
	if (typeof message !== "object" || message === null) return record;
	const role: unknown = Reflect.get(message, "role");
	if (typeof role !== "string") return record;
	const handoffs = findHandoffBlocks({ role, content: Reflect.get(message, "content") });
	return handoffs.length === 0 ? record : { ...record, handoffs };
}
