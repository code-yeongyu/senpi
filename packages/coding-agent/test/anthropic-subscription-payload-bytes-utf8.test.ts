import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { serializedPayloadBytes } from "../src/core/extensions/builtin/anthropic-subscription/prompt-directive-dedupe.ts";

const KOREAN = "토큰 와구먹는거 안고쳐진거같아여";
const EMOJI = "🔥🔥🔥";

function textBlocks(...texts: readonly string[]): ContentBlockParam[] {
	return texts.map((text) => ({ type: "text", text }) satisfies ContentBlockParam);
}

describe("serialized payload byte accounting", () => {
	it("counts multibyte Korean text as UTF-8 bytes, not UTF-16 code units", () => {
		const blocks = textBlocks(KOREAN);

		expect(serializedPayloadBytes(blocks)).toBe(Buffer.byteLength(KOREAN, "utf8"));
		expect(serializedPayloadBytes(blocks)).toBeGreaterThan(KOREAN.length);
	});

	it("counts surrogate-pair emoji as UTF-8 bytes", () => {
		const blocks = textBlocks(EMOJI);

		expect(serializedPayloadBytes(blocks)).toBe(Buffer.byteLength(EMOJI, "utf8"));
		expect(serializedPayloadBytes(blocks)).toBe(12);
	});

	it("sums every text block and ignores non-text blocks", () => {
		const blocks: ContentBlockParam[] = [
			...textBlocks(KOREAN, "ascii"),
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		];

		expect(serializedPayloadBytes(blocks)).toBe(Buffer.byteLength(KOREAN, "utf8") + 5);
	});

	it("returns zero for an empty block list", () => {
		expect(serializedPayloadBytes([])).toBe(0);
	});

	it("matches ASCII length exactly, where UTF-8 bytes and code units coincide", () => {
		const ascii = "plain ascii payload";

		expect(serializedPayloadBytes(textBlocks(ascii))).toBe(ascii.length);
	});
});
