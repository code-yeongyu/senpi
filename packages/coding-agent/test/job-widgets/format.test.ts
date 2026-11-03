import { describe, expect, it } from "vitest";

import { formatWidgetNumber } from "../../src/core/extensions/builtin/job-widgets/index.ts";

describe("widget number formatting", () => {
	const cases: [number, number | undefined, string][] = [
		[9_999, undefined, "9999"],
		[10_000, undefined, "10.0k"],
		[12_345, undefined, "12.3k"],
		[99_949, undefined, "99.9k"],
		[99_960, undefined, "100k"],
		[999_499, undefined, "999k"],
		[999_500, undefined, "1.0M"],
		[999_999, undefined, "1.0M"],
		[1_000_000, undefined, "1.0M"],
		[-999_999, undefined, "-1.0M"],
		[999_950_000, undefined, "1.0G"],
		[999_999_999_999, undefined, "1.0T"],
		[999_999, 2, "1.00M"],
		[999_994, 2, "999.99k"],
		[2.5e15, undefined, "2500T"],
	];

	it.each(cases)("prints %d (digits %s) as %s", (value, digits, text) => {
		expect(formatWidgetNumber(value, undefined, digits)).toBe(text);
	});
});
