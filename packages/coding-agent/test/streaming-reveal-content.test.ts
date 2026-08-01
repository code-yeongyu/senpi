import { getGraphemeSegmenter } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { BlockUnitCounter, buildDisplayMessage, visibleUnits } from "../src/modes/interactive/streaming-reveal.ts";
import { makeMessage, textAt, thinkingAt } from "./helpers/streaming-reveal.ts";

function fullSlice(text: string, units: number): string {
	if (units <= 0) return "";
	const segments = [...getGraphemeSegmenter().segment(text)];
	const segment = segments[Math.floor(units) - 1];
	return segment === undefined ? text : text.slice(0, segment.index + segment.segment.length);
}

describe("BlockUnitCounter", () => {
	test.each([
		["ASCII", ["a", "ab", "abc"]],
		["CJK", ["中", "中文", "中文汉"]],
		["emoji ZWJ", ["👨", "👨‍👩", "👨‍👩‍👧", "👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦!"]],
		["combining marks", ["e", "e\u0301", "e\u0301x", "e\u0301x\u0323"]],
	] as const)(
		"#given an append-only %s stream #when counting and slicing deltas #then matches a full grapheme recount",
		(_name, sequence) => {
			const counter = new BlockUnitCounter();
			for (const text of sequence) {
				const fullCount = [...getGraphemeSegmenter().segment(text)].length;
				expect(counter.count(0, text)).toBe(fullCount);
				for (let units = 0; units <= fullCount + 1; units++) {
					expect(counter.slice(0, text, units)).toBe(fullSlice(text, units));
				}
			}
		},
	);

	test("#given a cached short suffix #when text appends #then slices the new grapheme through the fast path", () => {
		const counter = new BlockUnitCounter();

		expect(counter.slice(0, "a", 2)).toBe("a");
		expect(counter.slice(0, "ab", 2)).toBe("ab");
		expect(counter.slice(1, "abc", 1.2)).toBe("a");
	});
});

describe("streaming reveal content helpers", () => {
	test("#given mixed ordered blocks #when slicing visible units #then preserves raw thinking and passthrough blocks", () => {
		const family = "👨‍👩‍👧‍👦";
		const thinking = { type: "thinking" as const, thinking: "中文" };
		const providerNative = { type: "providerNative" as const, subtype: "status", raw: { state: "running" } };
		const toolCall = {
			type: "toolCall" as const,
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
		};
		const target = makeMessage([
			{ type: "text", text: "A" },
			thinking,
			providerNative,
			{ type: "text", text: `${family}B` },
			toolCall,
		]);

		const visible = buildDisplayMessage(target, 4, false);
		const hidden = buildDisplayMessage(target, 2, true);

		expect(visibleUnits(target, false)).toBe(5);
		expect(thinkingAt(visible, 1)).toBe("中文");
		expect(textAt(visible, 3)).toBe(family);
		expect(visible.content[2]).toBe(providerNative);
		expect(visible.content[4]).toBe(toolCall);
		expect(visibleUnits(target, true)).toBe(3);
		expect(hidden.content[1]).toBe(thinking);
		expect(textAt(hidden, 3)).toBe(family);
		expect(textAt(target, 3)).toBe(`${family}B`);
	});

	test("#given a partially revealed timed Thought block #when building its display message #then preserves timing fields", () => {
		const target = makeMessage([{ type: "thinking", thinking: "reasoning", startedAt: 1_000, endedAt: 4_200 }]);

		const display = buildDisplayMessage(target, 3, false);
		const block = display.content[0];
		if (block?.type !== "thinking") throw new TypeError("Expected a thinking block");

		expect(block.thinking).toBe("rea");
		expect(block.startedAt).toBe(1_000);
		expect(block.endedAt).toBe(4_200);
	});
});
