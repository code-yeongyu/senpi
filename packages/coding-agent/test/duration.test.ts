import { describe, expect, test } from "vitest";
import { formatDuration } from "../src/utils/duration.ts";

describe("formatDuration", () => {
	test.each([
		[0, "0ms"],
		[999, "999ms"],
		[1000, "1.0s"],
		[1500, "1.5s"],
		[59999, "60.0s"],
		[60000, "1m 0s"],
		[90000, "1m 30s"],
		[3599999, "59m 59s"],
		[3600000, "1h 0m"],
		[86399999, "23h 59m"],
		[86400000, "1d 0h"],
		[-500, "-500ms"],
	])("formats %i milliseconds as %s", (ms, expected) => {
		expect(formatDuration(ms)).toBe(expected);
	});
});
