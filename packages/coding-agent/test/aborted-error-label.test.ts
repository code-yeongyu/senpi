import { describe, expect, it } from "vitest";
import { abortedErrorLabel } from "../src/modes/interactive/aborted-error-label.ts";

describe("abortedErrorLabel", () => {
	it("uses the persisted label when replaying an aborted message", () => {
		expect(abortedErrorLabel("Aborted after 2 retry attempts", 0)).toBe("Aborted after 2 retry attempts");
	});

	it("falls back to the plain abort label when there were no retries", () => {
		expect(abortedErrorLabel(undefined, 0)).toBe("Operation aborted");
	});

	it("formats a singular retry attempt label", () => {
		expect(abortedErrorLabel(undefined, 1)).toBe("Aborted after 1 retry attempt");
	});

	it("formats a plural retry attempts label", () => {
		expect(abortedErrorLabel(undefined, 2)).toBe("Aborted after 2 retry attempts");
	});
});
