import { describe, expect, test } from "vitest";
import { formatKeyText } from "../src/modes/interactive/components/keybinding-hints.js";
import {
	blendWorkingStatusShimmerRgbColor,
	formatToolHookStatusMessage,
	formatToolHookStatusMessageFrame,
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

describe("formatToolHookStatusMessage", () => {
	test("matches the Codex hook row wording with elapsed time", () => {
		expect(formatToolHookStatusMessage("PostToolUse", "matching project rules", 427)).toBe(
			"Running PostToolUse hook: matching project rules (7m 07s)",
		);
	});
});

describe("blendWorkingStatusShimmerRgbColor", () => {
	test("matches codex highlight-to-base blend order", () => {
		const highlight = { r: 110, g: 120, b: 130 };
		const base = { r: 10, g: 20, b: 30 };

		expect(blendWorkingStatusShimmerRgbColor(highlight, base, 0)).toEqual(base);
		expect(blendWorkingStatusShimmerRgbColor(highlight, base, 0.25)).toEqual({ r: 35, g: 45, b: 55 });
		expect(blendWorkingStatusShimmerRgbColor(highlight, base, 1)).toEqual(highlight);
	});
});

describe("formatWorkingStatusMessageFrame", () => {
	test("animates only the working text without changing its plain text", () => {
		const style = {
			base: (text: string) => `\x1b[2m${text}\x1b[22m`,
			glow: (text: string) => `\x1b[37m${text}\x1b[39m`,
			highlight: (text: string) => `\x1b[1m${text}\x1b[22m`,
			suffix: (text: string) => `\x1b[90m${text}\x1b[39m`,
		};

		const firstFrame = formatWorkingStatusMessageFrame("Working", 427, "esc", 0, style);
		const nextFrame = formatWorkingStatusMessageFrame("Working", 427, "esc", 1_000, style);
		const fixedSuffix = "\x1b[90m (7m 07s • esc to interrupt)\x1b[39m";

		expect(stripAnsi(firstFrame)).toBe("Working (7m 07s • esc to interrupt)");
		expect(stripAnsi(nextFrame)).toBe("Working (7m 07s • esc to interrupt)");
		expect(firstFrame.endsWith(fixedSuffix)).toBe(true);
		expect(nextFrame.endsWith(fixedSuffix)).toBe(true);
		expect(firstFrame.slice(0, -fixedSuffix.length)).not.toBe(nextFrame.slice(0, -fixedSuffix.length));
	});

	test("uses a two second shimmer sweep", () => {
		const style = {
			base: (text: string) => `base(${text})`,
			glow: (text: string) => `glow(${text})`,
			highlight: (text: string) => `highlight(${text})`,
			suffix: (text: string) => `suffix(${text})`,
		};

		const firstFrame = formatWorkingStatusMessageFrame("Working", 0, "esc", 0, style);
		const halfwayFrame = formatWorkingStatusMessageFrame("Working", 0, "esc", 1_000, style);
		const nextSweepFrame = formatWorkingStatusMessageFrame("Working", 0, "esc", 2_000, style);

		expect(halfwayFrame).not.toBe(firstFrame);
		expect(nextSweepFrame).toBe(firstFrame);
	});

	test("allows continuous shimmer styling for smooth fade bands", () => {
		const intensities: number[] = [];
		const style = {
			base: (text: string) => `base(${text})`,
			glow: (text: string) => `glow(${text})`,
			highlight: (text: string) => `highlight(${text})`,
			shimmer: (text: string, intensity: number) => {
				intensities.push(intensity);
				return `${text}:${intensity.toFixed(3)}`;
			},
			suffix: (text: string) => `suffix(${text})`,
		};

		const frame = formatWorkingStatusMessageFrame("Working", 0, "esc", 1_000, style);

		expect(stripAnsi(frame)).toContain("suffix( (0s • esc to interrupt))");
		expect(intensities.length).toBe("Working".length);
		expect(intensities.some((intensity) => intensity > 0 && intensity < 1)).toBe(true);
	});
});

describe("formatToolHookStatusMessageFrame", () => {
	test("animates only the running hook label without changing plain text", () => {
		const style = {
			base: (text: string) => `\x1b[2m${text}\x1b[22m`,
			glow: (text: string) => `\x1b[37m${text}\x1b[39m`,
			highlight: (text: string) => `\x1b[1m${text}\x1b[22m`,
			suffix: (text: string) => `\x1b[90m${text}\x1b[39m`,
		};

		const firstFrame = formatToolHookStatusMessageFrame("PostToolUse", "matching project rules", 427, 0, style);
		const nextFrame = formatToolHookStatusMessageFrame("PostToolUse", "matching project rules", 427, 1_000, style);
		const fixedSuffix = "\x1b[90m: matching project rules (7m 07s)\x1b[39m";

		expect(stripAnsi(firstFrame)).toBe("Running PostToolUse hook: matching project rules (7m 07s)");
		expect(stripAnsi(nextFrame)).toBe("Running PostToolUse hook: matching project rules (7m 07s)");
		expect(firstFrame.endsWith(fixedSuffix)).toBe(true);
		expect(nextFrame.endsWith(fixedSuffix)).toBe(true);
		expect(firstFrame.slice(0, -fixedSuffix.length)).not.toBe(nextFrame.slice(0, -fixedSuffix.length));
	});
});
