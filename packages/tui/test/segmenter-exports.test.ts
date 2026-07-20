import assert from "node:assert";
import { describe, it } from "node:test";
import { getGraphemeSegmenter, getWordSegmenter } from "../src/index.ts";
import * as utils from "../src/utils.ts";

describe("segmenter package-root exports", () => {
	it("re-exports the shared grapheme segmenter", () => {
		assert.strictEqual(getGraphemeSegmenter, utils.getGraphemeSegmenter);
		const segmenter = getGraphemeSegmenter();
		assert.strictEqual(segmenter, getGraphemeSegmenter(), "expected one shared instance");
		assert.strictEqual(segmenter.resolvedOptions().granularity, "grapheme");
		const segments = [...segmenter.segment("a👍🏽b")];
		assert.strictEqual(segments.length, 3, "emoji modifier sequence must stay one cluster");
	});

	it("re-exports the shared word segmenter", () => {
		assert.strictEqual(getWordSegmenter, utils.getWordSegmenter);
		assert.strictEqual(getWordSegmenter(), getWordSegmenter(), "expected one shared instance");
		assert.strictEqual(getWordSegmenter().resolvedOptions().granularity, "word");
	});
});
