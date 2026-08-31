import { describe, expect, it } from "vitest";
import { isAccessDeniedErrorMessage } from "../../src/core/retry-fallback/access-denied.ts";

describe("isAccessDeniedErrorMessage", () => {
	it("matches hard access-denied signals", () => {
		expect(isAccessDeniedErrorMessage("HTTP 403 from provider")).toBe(true);
		expect(isAccessDeniedErrorMessage("Forbidden: model not enabled for this account")).toBe(true);
		expect(
			isAccessDeniedErrorMessage(
				"ActionRequiredError: acknowledge the data retention policy before using claude-fable-5",
			),
		).toBe(true);
		expect(isAccessDeniedErrorMessage("Access denied by organization policy")).toBe(true);
		expect(isAccessDeniedErrorMessage("Model is not available for your plan")).toBe(true);
	});

	it("does not match transient or billing failures", () => {
		expect(isAccessDeniedErrorMessage("429 rate limited, retry after 5s")).toBe(false);
		expect(isAccessDeniedErrorMessage("credit balance too low, purchase credits")).toBe(false);
		expect(isAccessDeniedErrorMessage("stream idle timeout")).toBe(false);
		expect(isAccessDeniedErrorMessage("Internal server error 500")).toBe(false);
		expect(isAccessDeniedErrorMessage(undefined)).toBe(false);
	});
});
