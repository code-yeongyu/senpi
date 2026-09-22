import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";

const ULTRAWORK_MODE_OPEN_TAG = "<ultrawork-mode>";
const ULTRAWORK_MODE_CLOSE_TAG = "</ultrawork-mode>";
const SUPERSEDED_PLACEHOLDER = "[ultrawork directive superseded; the latest ultrawork directive block below applies]";

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
 * Collapse repeated `<ultrawork-mode>...</ultrawork-mode>` directive spans in a
 * serialized prompt to the single most recent copy; earlier spans become a
 * one-line placeholder. Without this, every flatten/bootstrap re-send bills
 * ~17KB per duplicate (issue #494's 875KB prompt was 73% such duplicates).
 *
 * Invariants (load-bearing): spans match WITHIN a single text block — a lone
 * open tag in one block and a close tag in another never form a span; the LAST
 * span in serialization order is kept; the input array is never mutated, so
 * continuity hashes (derived from `context.messages` in `session-sync.ts`, not
 * from this serialized output) are unaffected.
 */
export function dedupeUltraworkBlocks(blocks: readonly ContentBlockParam[]): DedupeResult {
	if (hasNestedDirective(blocks)) return { blocks: [...blocks], collapsedDirectives: 0 };

	let total = 0;
	for (const block of blocks) {
		if (block.type === "text") total += countSpans(block.text);
	}
	if (total === 0) return { blocks: [...blocks], collapsedDirectives: 0 };

	let remaining = total;
	const next: ContentBlockParam[] = [];
	for (const block of blocks) {
		if (block.type !== "text") {
			next.push(block);
			continue;
		}
		next.push({
			type: "text",
			text: block.text.replace(ULTRAWORK_SPAN_PATTERN, (match) => {
				remaining -= 1;
				return remaining === 0 ? match : SUPERSEDED_PLACEHOLDER;
			}),
		});
	}
	return { blocks: next, collapsedDirectives: total - 1 };
}
