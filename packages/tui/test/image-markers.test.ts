import assert from "node:assert";
import { describe, it } from "node:test";
import {
	IMAGE_MARKER_REGEX,
	IMAGE_MARKER_SINGLE,
	ImageMarkerRegistry,
	imageMarkerId,
	isImageMarker,
} from "../src/image-markers.ts";
import { isPasteMarker, segmentWithMarkers, segmentWithPasteMarkers } from "../src/paste-markers.ts";

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function segments(text: string, markers: Iterable<string>): string[] {
	return [...segmentWithMarkers(text, graphemeSegmenter, new Set(markers))].map((entry) => entry.segment);
}

describe("image marker primitives", () => {
	it("recognizes canonical markers and rejects malformed ones", () => {
		assert.strictEqual(isImageMarker("[Image #1]"), true);
		assert.strictEqual(isImageMarker("[Image #12]"), true);
		assert.strictEqual(imageMarkerId("[Image #12]"), 12);
		assert.strictEqual(imageMarkerId("[Image #1]"), 1);

		for (const invalid of ["[Image #0]", "[Image #]", "[image #1]", "[paste #1 3 chars]", "[Image #1", "Image #1"]) {
			assert.strictEqual(isImageMarker(invalid), false, invalid);
			assert.strictEqual(imageMarkerId(invalid), undefined, invalid);
		}
	});

	it("keeps the single and global regexes in sync on the canonical form", () => {
		assert.strictEqual(IMAGE_MARKER_SINGLE.test("[Image #3]"), true);
		assert.strictEqual(IMAGE_MARKER_SINGLE.test("a [Image #3]"), false);
		assert.deepStrictEqual(
			[..."b [Image #2] a [Image #1]".matchAll(IMAGE_MARKER_REGEX)].map((match) => match[0]),
			["[Image #2]", "[Image #1]"],
		);
	});

	it("does not classify paste markers as image markers", () => {
		assert.strictEqual(isImageMarker("[paste #1 3 chars]"), false);
		assert.strictEqual(isPasteMarker("[Image #1]"), false);
	});
});

describe("ImageMarkerRegistry", () => {
	it("issues canonical markers in insertion order", () => {
		const registry = new ImageMarkerRegistry();
		assert.strictEqual(registry.add(), "[Image #1]");
		assert.strictEqual(registry.add(), "[Image #2]");
		assert.deepStrictEqual(registry.snapshot(), { ids: [1, 2], imageCounter: 2 });
	});

	it("excludes a marker appearing twice from the authorized set", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		const authorized = registry.authorizedMarkers("[Image #1] [Image #2] [Image #1]");
		assert.strictEqual(authorized.has("[Image #2]"), true);
		assert.strictEqual(authorized.has("[Image #1]"), false);
	});

	it("reports ids in text reading order, not insertion order", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		assert.deepStrictEqual(registry.ids("b [Image #2] a [Image #1]"), [2, 1]);
		assert.deepStrictEqual(registry.ids("[Image #1] [Image #2]"), [1, 2]);
	});

	it("ignores unregistered and duplicated markers when reading ids", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		assert.deepStrictEqual(registry.ids("[Image #1] [Image #7]"), [1]);
		assert.deepStrictEqual(registry.ids("[Image #1] [Image #1]"), []);
	});

	it("removes a marker and renumbers higher ids downward", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		const removal = registry.remove(1, "x [Image #1] y [Image #2]");

		assert.strictEqual(removal.removed, true);
		assert.strictEqual(removal.text, "x  y [Image #1]");
		assert.deepStrictEqual(registry.ids(removal.text), [1]);
		assert.deepStrictEqual(registry.snapshot(), { ids: [1], imageCounter: 1 });
	});

	it("reports no removal for an unknown id", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		const removal = registry.remove(9, "x [Image #1]");
		assert.deepStrictEqual(removal, { text: "x [Image #1]", removed: false });
	});

	it("renumbers so the next add continues after the survivors", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		const removal = registry.remove(1, "[Image #1] [Image #2]");
		assert.strictEqual(removal.text, " [Image #1]");
		assert.strictEqual(registry.add(), "[Image #2]");
	});

	it("canonicalizes markers to reading order and reports the original order", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		const result = registry.canonicalize("b [Image #2] a [Image #1]");

		assert.strictEqual(result.text, "b [Image #1] a [Image #2]");
		assert.deepStrictEqual(result.order, [2, 1]);
		assert.deepStrictEqual(registry.ids(result.text), [1, 2]);
	});

	it("leaves already-canonical text untouched", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		const result = registry.canonicalize("[Image #1] [Image #2]");
		assert.strictEqual(result.text, "[Image #1] [Image #2]");
		assert.deepStrictEqual(result.order, [1, 2]);
	});

	it("prunes markers absent from the text", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		registry.prune("only [Image #2] survives");

		assert.deepStrictEqual(registry.snapshot(), { ids: [2], imageCounter: 2 });
		assert.deepStrictEqual(registry.ids("only [Image #2] survives"), [2]);
	});

	it("prunes markers that were not authorized in the previous text", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.prune("[Image #1]", "[Image #1] [Image #1]");
		assert.deepStrictEqual(registry.snapshot(), { ids: [], imageCounter: 0 });
	});

	it("round-trips through snapshot and restore", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		const state = registry.snapshot();

		const restored = new ImageMarkerRegistry();
		restored.restore(state);
		assert.deepStrictEqual(restored.ids("[Image #1] [Image #2]"), [1, 2]);
		assert.strictEqual(restored.add(), "[Image #3]");
	});

	it("prunes on install against the current text", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.add();
		const state = registry.snapshot();

		const installed = new ImageMarkerRegistry();
		installed.install(state, "keeps [Image #2]");
		assert.deepStrictEqual(installed.ids("keeps [Image #2]"), [2]);
		assert.deepStrictEqual(installed.snapshot(), { ids: [2], imageCounter: 2 });
	});

	it("clears ids and the counter", () => {
		const registry = new ImageMarkerRegistry();
		registry.add();
		registry.clear();
		assert.deepStrictEqual(registry.snapshot(), { ids: [], imageCounter: 0 });
		assert.strictEqual(registry.add(), "[Image #1]");
	});
});

describe("segmentWithMarkers", () => {
	it("returns an image marker as one segment", () => {
		assert.deepStrictEqual(segments("a[Image #1]b", ["[Image #1]"]), ["a", "[Image #1]", "b"]);
	});

	it("keeps unauthorized markers split into graphemes", () => {
		assert.deepStrictEqual(segments("[Image #1]", []), [..."[Image #1]"]);
		assert.deepStrictEqual(segments("[Image #2]", ["[Image #1]"]), [..."[Image #2]"]);
	});

	it("segments a mixed marker set atomically", () => {
		assert.deepStrictEqual(segments("[Image #1][paste #1 3 chars]!", ["[Image #1]", "[paste #1 3 chars]"]), [
			"[Image #1]",
			"[paste #1 3 chars]",
			"!",
		]);
	});

	it("keeps segmentWithPasteMarkers behavior for paste markers", () => {
		const result = [
			...segmentWithPasteMarkers("a[paste #1 3 chars]b", graphemeSegmenter, new Set(["[paste #1 3 chars]"])),
		].map((entry) => entry.segment);
		assert.deepStrictEqual(result, ["a", "[paste #1 3 chars]", "b"]);
	});

	it("ignores paste markers that are not authorized", () => {
		const result = [...segmentWithPasteMarkers("a[paste #1 3 chars]b", graphemeSegmenter, new Set())].map(
			(entry) => entry.segment,
		);
		assert.deepStrictEqual(result, [..."a[paste #1 3 chars]b"]);
	});
});
