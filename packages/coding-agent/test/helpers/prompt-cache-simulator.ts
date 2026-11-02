import { createHash } from "node:crypto";
import type { ContentBlockParam } from "../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";

/**
 * Offline model of the Messages API prompt cache, for measuring what a rebuilt cold-seed prompt reads from and writes
 * to the cache without a live model call. It follows the documented rules: a `cache_control` block writes the prefix
 * that ends at it, and a later request reads the longest earlier-written prefix whose end lies within
 * `CACHE_LOOKBACK_BLOCKS` blocks before its own breakpoint. Only the user-message content blocks are modelled; the
 * system prompt and tools are identical between the compared requests.
 *
 * Token counts are estimates: text at 4 characters per token, every image at `IMAGE_TOKENS` (a screenshot-sized image).
 */
export const CACHE_LOOKBACK_BLOCKS = 20;
export const IMAGE_TOKENS = 1_600;

export type CacheUsage = { readonly cacheRead: number; readonly cacheWrite: number; readonly uncached: number };

function blockTokens(block: ContentBlockParam): number {
	if (block.type === "text") return Math.ceil(block.text.length / 4);
	if (block.type === "image") return IMAGE_TOKENS;
	return Math.ceil(JSON.stringify(block).length / 4);
}

function blockKey(block: ContentBlockParam): string {
	const { cache_control: _marker, ...rest } = block as ContentBlockParam & { cache_control?: unknown };
	return JSON.stringify(rest);
}

export function prefixHashes(blocks: readonly ContentBlockParam[]): string[] {
	const hashes: string[] = [];
	let previous = "";
	for (const block of blocks) {
		previous = createHash("sha256").update(previous).update(blockKey(block)).digest("hex");
		hashes.push(previous);
	}
	return hashes;
}

export function firstDivergence(a: readonly ContentBlockParam[], b: readonly ContentBlockParam[]): number {
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		if (blockKey(a[index] as ContentBlockParam) !== blockKey(b[index] as ContentBlockParam)) return index;
	}
	return length;
}

export function breakpointIndex(blocks: readonly ContentBlockParam[]): number {
	return blocks.findLastIndex((block) => (block as { cache_control?: unknown }).cache_control !== undefined);
}

export class PromptCacheSimulator {
	private readonly written = new Set<string>();

	request(blocks: readonly ContentBlockParam[]): CacheUsage {
		const tokens = blocks.map(blockTokens);
		const sum = (from: number, to: number): number => tokens.slice(from, to).reduce((a, b) => a + b, 0);
		const breakpoint = breakpointIndex(blocks);
		if (breakpoint < 0) return { cacheRead: 0, cacheWrite: 0, uncached: sum(0, tokens.length) };
		const hashes = prefixHashes(blocks);
		let hit = -1;
		for (let index = breakpoint; index >= Math.max(0, breakpoint - CACHE_LOOKBACK_BLOCKS); index--) {
			if (this.written.has(hashes[index] as string)) {
				hit = index;
				break;
			}
		}
		this.written.add(hashes[breakpoint] as string);
		return {
			cacheRead: sum(0, hit + 1),
			cacheWrite: sum(hit + 1, breakpoint + 1),
			uncached: sum(breakpoint + 1, tokens.length),
		};
	}
}
