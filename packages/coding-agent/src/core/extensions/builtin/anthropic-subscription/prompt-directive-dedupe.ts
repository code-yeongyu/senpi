import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { CONVERSATION_HISTORY_CLOSER } from "./prompt-bridge.ts";

const ULTRAWORK_MODE_OPEN_TAG = "<ultrawork-mode>";
const ULTRAWORK_MODE_CLOSE_TAG = "</ultrawork-mode>";
const REPEATED_PLACEHOLDER = "[ultrawork directive repeated; identical to the ultrawork directive just above]";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ULTRAWORK_SPAN_PATTERN = new RegExp(
	`${escapeRegExp(ULTRAWORK_MODE_OPEN_TAG)}[\\s\\S]*?${escapeRegExp(ULTRAWORK_MODE_CLOSE_TAG)}`,
	"g",
);

/** Every opening and closing tag, in order, for depth tracking across blocks. */
const ULTRAWORK_TAG_PATTERN = new RegExp(
	`${escapeRegExp(ULTRAWORK_MODE_OPEN_TAG)}|${escapeRegExp(ULTRAWORK_MODE_CLOSE_TAG)}`,
	"g",
);

function countSpans(text: string): number {
	return (text.match(ULTRAWORK_SPAN_PATTERN) ?? []).length;
}

/**
 * True when the serialized blocks contain a nested directive, tracking tag depth
 * across the WHOLE block sequence rather than per block. `buildPromptBlocks`
 * splits turns and content chunks into separate blocks, so a nested directive
 * can straddle them (`<ultrawork-mode>outer ` | `<ultrawork-mode>inner</...>` |
 * ` tail</...>`); a per-block scan misses that and the non-greedy span regex then
 * pairs the outer open with the inner close, stranding tags and silently eating
 * an earlier directive. Nesting is pathological rather than expected, so callers
 * fail closed on it instead of emitting a corrupted prompt.
 *
 * Unmatched lone tags are NOT nesting: a close with no open is ignored, and a
 * trailing unclosed open leaves depth high without ever exceeding one. Both are
 * left byte-identical by contract.
 */
function hasNestedDirective(blocks: readonly ContentBlockParam[]): boolean {
	let depth = 0;
	for (const block of blocks) {
		if (block.type !== "text") continue;
		for (const token of block.text.matchAll(ULTRAWORK_TAG_PATTERN)) {
			if (token[0] === ULTRAWORK_MODE_OPEN_TAG) {
				depth += 1;
				if (depth > 1) return true;
			} else if (depth > 0) {
				depth -= 1;
			}
		}
	}
	return false;
}

export interface DedupeResult {
	blocks: ContentBlockParam[];
	collapsedDirectives: number;
}

/**
 * Total UTF-8 byte size of the serialized prompt's text blocks. Uses
 * `Buffer.byteLength` rather than `String.length`, which counts UTF-16 code
 * units and understates every multibyte payload (Korean, emoji, CJK) that the
 * lane actually pays for on the wire.
 */
export function serializedPayloadBytes(blocks: readonly ContentBlockParam[]): number {
	let total = 0;
	for (const block of blocks) {
		if (block.type === "text") total += Buffer.byteLength(block.text, "utf8");
	}
	return total;
}

/**
 * Collapse repeated `<ultrawork-mode>...</ultrawork-mode>` directive spans in a serialized
 * prompt. Without this, every flatten/bootstrap re-send bills ~17KB per duplicate (issue #494's
 * 875KB prompt was 73% such duplicates).
 *
 * Invariants (load-bearing):
 * - Spans match WITHIN a single text block; a lone open tag in one block and a close tag in
 *   another never form a span.
 * - Inside the replayed history (before `CONVERSATION_HISTORY_CLOSER`), a directive identical to the
 *   directive just before it becomes a placeholder; a directive whose text differs is kept in full,
 *   so the newest wording is always present and an A, B, A sequence keeps all three. Each decision
 *   depends only on earlier blocks, so a rebuilt prompt stays a byte prefix of the next one and
 *   reads its history from the prompt cache (senpi#2982). Keeping the last copy instead rewrote an
 *   earlier block every time a new directive arrived.
 * - After the closer (the current turn), nothing is collapsed: the active directive stays in full.
 * - Other block fields (`cache_control`) are preserved, and the input array is never mutated, so
 *   continuity hashes (derived from `context.messages` in `session-sync.ts`) are unaffected.
 */
export function dedupeUltraworkBlocks(blocks: readonly ContentBlockParam[]): DedupeResult {
	if (hasNestedDirective(blocks)) return { blocks: [...blocks], collapsedDirectives: 0 };
	const closerIndex = blocks.findIndex((block) => block.type === "text" && block.text === CONVERSATION_HISTORY_CLOSER);
	let previous: string | undefined;
	let collapsedDirectives = 0;
	const next = blocks.map((block, index): ContentBlockParam => {
		if (block.type !== "text" || index >= closerIndex) return block;
		if (countSpans(block.text) === 0) return block;
		const text = block.text.replace(ULTRAWORK_SPAN_PATTERN, (match) => {
			if (match !== previous) {
				previous = match;
				return match;
			}
			collapsedDirectives += 1;
			return REPEATED_PLACEHOLDER;
		});
		return { ...block, text };
	});
	return { blocks: next, collapsedDirectives };
}
