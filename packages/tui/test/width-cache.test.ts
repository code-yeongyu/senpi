import assert from "node:assert";
import { describe, it } from "node:test";
import * as utils from "../src/utils.ts";

process.env.PI_TUI_TEST_SEAMS = "1";

function styledKey(prefix: string, index: number): string {
	return `\x1b[31m${prefix}-${index}-한글\x1b[0m`;
}

type WidthCacheStats = NonNullable<ReturnType<typeof utils.__widthCacheStats>>;

function widthCacheStats(): WidthCacheStats {
	const stats = utils.__widthCacheStats();
	if (stats === undefined) {
		assert.fail("width cache stats seam must be enabled");
	}
	return stats;
}

describe("visibleWidth width cache", () => {
	it("keeps rotated keys retrievable from the previous generation", () => {
		// given
		const keys = Array.from({ length: 2049 }, (_, index) => styledKey("generation", index));

		// when
		for (const key of keys) {
			utils.visibleWidth(key);
		}
		const afterRotation = widthCacheStats();
		const hitsBeforeProbe = afterRotation.hits;
		const firstWidth = utils.visibleWidth(keys[0] ?? "");
		const afterProbe = widthCacheStats();

		// then
		assert.strictEqual(firstWidth, 17);
		assert.strictEqual(afterProbe.hits, hitsBeforeProbe + 1);
		assert.ok(afterRotation.totalRetained <= 4096);
		assert.ok(afterProbe.totalRetained <= 4096);
	});

	it("returns identical widths for a 50-case corpus before and after rotation", () => {
		// given
		const corpus = [
			...Array.from({ length: 10 }, (_, index) => `ascii-${index}-plain`),
			...Array.from({ length: 10 }, (_, index) => `한글-${index}-中文`),
			...Array.from({ length: 10 }, (_, index) => `emoji-${index}-👨‍💻-🏳️‍🌈`),
			...Array.from({ length: 10 }, (_, index) => `\x1b[3${index % 8}mansi-${index}-한\x1b[0m`),
			...Array.from(
				{ length: 10 },
				(_, index) => `\x1b]8;;https://example.com/${index}\x1b\\osc-${index}-界\x1b]8;;\x1b\\`,
			),
		];
		assert.strictEqual(corpus.length, 50);
		const before = corpus.map((entry) => utils.visibleWidth(entry));

		// when
		for (let index = 0; index < 5000; index++) {
			utils.visibleWidth(styledKey("rotation-filler", index));
		}
		const after = corpus.map((entry) => utils.visibleWidth(entry));

		// then
		assert.deepStrictEqual(after, before);
	});

	it("keeps at least half of repeated 3000-key cyclic sweeps on cache hits", () => {
		// given
		const keys = Array.from({ length: 3000 }, (_, index) => styledKey("cyclic", index));
		for (const key of keys) {
			utils.visibleWidth(key);
		}
		const before = widthCacheStats();

		// when
		for (let repeat = 0; repeat < 10; repeat++) {
			for (const key of keys) {
				utils.visibleWidth(key);
			}
		}
		const after = widthCacheStats();

		// then
		const hits = after.hits - before.hits;
		const misses = after.misses - before.misses;
		assert.ok(hits + misses > 0);
		assert.ok(hits / (hits + misses) >= 0.5, `expected hit rate >= 0.5, got ${hits}/${hits + misses}`);
		assert.ok(after.totalRetained <= 4096);
	});
});
