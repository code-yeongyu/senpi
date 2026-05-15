import { describe, expect, test } from "vitest";
import { formatKeyText } from "../src/modes/interactive/components/keybinding-hints.js";
import {
	formatWorkingElapsedSeconds,
	formatWorkingStatusMessage,
	formatWorkingStatusMessageFrame,
} from "../src/modes/interactive/working-status.js";
import { stripAnsi } from "../src/utils/ansi.js";

describe("formatKeyText", () => {
	test("uses compact escape labels for status hints", () => {
		expect(formatKeyText("escape")).toBe("esc");
		expect(formatKeyText("escape", { capitalize: true })).toBe("Esc");
	});
});

describe("formatWorkingElapsedSeconds", () => {
	test("formats elapsed working time with padded larger units", () => {
		expect(formatWorkingElapsedSeconds(-1)).toBe("0s");
		expect(formatWorkingElapsedSeconds(7.9)).toBe("7s");
		expect(formatWorkingElapsedSeconds(59)).toBe("59s");
		expect(formatWorkingElapsedSeconds(60)).toBe("1m 00s");
		expect(formatWorkingElapsedSeconds(427)).toBe("7m 07s");
		expect(formatWorkingElapsedSeconds(3600)).toBe("1h 00m 00s");
		expect(formatWorkingElapsedSeconds(3667)).toBe("1h 01m 07s");
	});
});

describe("formatWorkingStatusMessage", () => {
	test("combines message, elapsed time, and interrupt hint", () => {
		expect(formatWorkingStatusMessage("Working", 427, "esc")).toBe("Working (7m 07s • esc to interrupt)");
	});
});

describe("formatWorkingStatusMessageFrame", () => {
	test("animates the status text without changing its plain text", () => {
		const style = {
			base: (text: string) => `\x1b[2m${text}\x1b[22m`,
			glow: (text: string) => `\x1b[37m${text}\x1b[39m`,
			highlight: (text: string) => `\x1b[1m${text}\x1b[22m`,
		};

		const firstFrame = formatWorkingStatusMessageFrame("Working", 427, "esc", 8, style);
		const nextFrame = formatWorkingStatusMessageFrame("Working", 427, "esc", 12, style);

		expect(stripAnsi(firstFrame)).toBe("Working (7m 07s • esc to interrupt)");
		expect(stripAnsi(nextFrame)).toBe("Working (7m 07s • esc to interrupt)");
		expect(firstFrame).not.toBe(nextFrame);
	});
});
