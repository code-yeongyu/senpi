import { describe, expect, it } from "vitest";
import * as errors from "../src/core/extensions/builtin/claude-sdk-oauth/errors.ts";
import { withAuthGuidance } from "../src/core/extensions/builtin/claude-sdk-oauth/stream-guidance.ts";

const fableUsageCredits =
	"Claude Code returned an error result: Fable 5 requires usage credits. Run /usage-credits to continue or switch models with /model.";
const entitlementGuidance =
	"This model needs usage credits on the selected Claude account (it is not included in the subscription). Switch models with /model, enable usage credits at claude.com, or pick another account with /claude-account pin <name>.";

const versionFloor = {
	type: "result",
	subtype: "success",
	is_error: true,
	api_error_status: 400,
	terminal_reason: "api_error",
	result:
		"API Error: 400 Claude Code 2.1.241 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
	modelUsage: {},
};

function exported(name: string): unknown {
	return Reflect.get(errors, name);
}

describe("Claude SDK OAuth error extraction", () => {
	it("surfaces result text, status, and terminal reason from real SDK result shapes", () => {
		const failure = exported("sdkResultFailure");
		expect(typeof failure).toBe("function");
		if (typeof failure !== "function") return;
		const error = failure(versionFloor);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("does not support this model");
		expect(error.message).toContain("HTTP 400, api_error");
		expect(failure({ type: "result", subtype: "success", is_error: false, result: "ok" })).toBeUndefined();
		expect(
			failure({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["You've hit your session limit"],
			}),
		).toMatchObject({ message: "You've hit your session limit" });
	});

	it("prefers assistant text over unknown while retaining informative SDK codes", () => {
		const failure = exported("sdkAssistantFailure");
		expect(typeof failure).toBe("function");
		if (typeof failure !== "function") return;
		const assistant = (error: string, text: string) => ({
			type: "assistant",
			error,
			message: { content: [{ type: "text", text }] },
		});
		expect(failure(assistant("unknown", versionFloor.result))).toMatchObject({ message: versionFloor.result });
		const rateLimit = failure(assistant("rate_limit", "You've hit your session limit"));
		expect(rateLimit.message).toMatch(/\(rate_limit\)$/);
		expect(errors.classifySdkError(rateLimit)).toEqual({ kind: "rate_limit", retryable: true });
	});

	it("distinguishes transient refresh transport failures from rejected credentials", () => {
		expect(errors.classifySdkError("authentication_failed: getaddrinfo ENOTFOUND platform.claude.com")).toEqual({
			kind: "other",
			retryable: true,
		});
		expect(errors.classifySdkError("invalid_grant")).toEqual({ kind: "auth_error", retryable: true });
	});

	it("classifies Fable usage-credit prose as a non-retryable entitlement", () => {
		expect(errors.classifySdkError(fableUsageCredits)).toEqual({ kind: "entitlement", retryable: false });
		expect(errors.classifySdkError("credits_required")).toEqual({ kind: "entitlement", retryable: false });
		const guided = withAuthGuidance(fableUsageCredits, fableUsageCredits);
		expect(guided.startsWith(fableUsageCredits)).toBe(true);
		expect(guided).toContain(entitlementGuidance);
	});
});
