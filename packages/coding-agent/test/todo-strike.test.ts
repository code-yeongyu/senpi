import { describe, expect, test } from "vitest";
import {
	hasCompletedTodoTasks,
	partialStrikethrough,
	strikeRevealCount,
	TODO_STRIKE_HOLD_FRAMES,
	TODO_STRIKE_TOTAL_FRAMES,
} from "../src/modes/interactive/components/todo-strike.ts";

const markerStrike = (text: string): string => `<s>${text}</s>`;

describe("strikeRevealCount", () => {
	test("undefined frame returns undefined", () => {
		expect(strikeRevealCount("abc", undefined)).toBeUndefined();
	});

	test("hold frames 0, 1, 2 return 0", () => {
		expect(strikeRevealCount("abc", 0)).toBe(0);
		expect(strikeRevealCount("abc", 1)).toBe(0);
		expect(strikeRevealCount("abc", 2)).toBe(0);
		expect(strikeRevealCount("abc", TODO_STRIKE_HOLD_FRAMES)).toBe(0);
	});

	test("frame 3 with 12-char text reveals 1 code point", () => {
		expect(strikeRevealCount("123456789012", 3)).toBe(1);
	});

	test("frame >= TOTAL reveals full length", () => {
		expect(strikeRevealCount("abc", TODO_STRIKE_TOTAL_FRAMES)).toBe(3);
		expect(strikeRevealCount("abc", TODO_STRIKE_TOTAL_FRAMES + 5)).toBe(3);
	});

	test("empty string returns undefined for a revealing frame", () => {
		expect(strikeRevealCount("", TODO_STRIKE_HOLD_FRAMES + 1)).toBeUndefined();
	});

	test("splits on code points, not UTF-16 units", () => {
		// "ab🎉cd" is 5 code points but 6 UTF-16 code units (🎉 is a surrogate pair).
		const text = "ab🎉cd";
		expect([...text].length).toBe(5);
		// Full reveal reports 5 code points, not 6 UTF-16 units.
		expect(strikeRevealCount(text, TODO_STRIKE_TOTAL_FRAMES)).toBe(5);
		// First reveal step: ceil(5 * 1 / 12) = 1 code point.
		expect(strikeRevealCount(text, TODO_STRIKE_HOLD_FRAMES + 1)).toBe(1);
	});
});

describe("partialStrikethrough", () => {
	test("visibleChars <= 0 returns text unchanged", () => {
		expect(partialStrikethrough("abc", 0, markerStrike)).toBe("abc");
		expect(partialStrikethrough("abc", -3, markerStrike)).toBe("abc");
	});

	test("visibleChars >= length strikes the whole text", () => {
		expect(partialStrikethrough("abc", 3, markerStrike)).toBe("<s>abc</s>");
		expect(partialStrikethrough("abc", 10, markerStrike)).toBe("<s>abc</s>");
	});

	test("mid boundary strikes the prefix only", () => {
		expect(partialStrikethrough("abc", 2, markerStrike)).toBe("<s>ab</s>c");
	});

	test("splits on code points, not UTF-16 units", () => {
		// visibleChars=3 strikes "ab🎉" (3 code points), leaving "cd" unstriked.
		expect(partialStrikethrough("ab🎉cd", 3, markerStrike)).toBe("<s>ab🎉</s>cd");
	});
});

describe("hasCompletedTodoTasks", () => {
	test("true when completedTasks is a non-empty array", () => {
		expect(hasCompletedTodoTasks({ completedTasks: [{ label: "x" }] })).toBe(true);
	});

	test("false when completedTasks is an empty array", () => {
		expect(hasCompletedTodoTasks({ completedTasks: [] })).toBe(false);
	});

	test("false when completedTasks is missing", () => {
		expect(hasCompletedTodoTasks({ other: 1 })).toBe(false);
	});

	test("false for null", () => {
		expect(hasCompletedTodoTasks(null)).toBe(false);
	});

	test("false for non-object primitives", () => {
		expect(hasCompletedTodoTasks(42)).toBe(false);
		expect(hasCompletedTodoTasks("str")).toBe(false);
		expect(hasCompletedTodoTasks(undefined)).toBe(false);
	});

	test("false when completedTasks is not an array", () => {
		expect(hasCompletedTodoTasks({ completedTasks: "nope" })).toBe(false);
	});
});
