import { describe, expect, it } from "vitest";
import { sanitizeBinaryOutput } from "../src/utils/shell.ts";

describe("sanitizeBinaryOutput", () => {
	it("returns clean ASCII output unchanged", () => {
		const output = "line one\nline two\tok";

		const sanitized = sanitizeBinaryOutput(output);

		expect(sanitized).toBe(output);
	});

	it("removes disallowed controls while keeping tab and newlines", () => {
		const output = "a\x00b\tc\nd\re\x07f";

		const sanitized = sanitizeBinaryOutput(output);

		expect(sanitized).toBe("ab\tc\nd\ref");
	});

	it("removes unicode format characters that break width calculation", () => {
		const output = "before\ufff9hidden\ufffbafter";

		const sanitized = sanitizeBinaryOutput(output);

		expect(sanitized).toBe("beforehiddenafter");
	});
});
