import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";

function failed(errorMessage: string): AssistantMessage {
	return { ...fauxAssistantMessage(""), stopReason: "error", errorMessage };
}

const refusals = [
	{
		name: "OpenCode Go subscription required",
		text: '403: {"type":"server_error","message":"Upstream request failed: An active OpenCode Go subscription is required to use Go models."}',
		scope: "model",
	},
	{
		name: "Z.ai 1313 abnormal-usage lock",
		text: '429: {"code":"1313","message":"Your request frequency has been limited due to abnormal usage. To restore access, please submit a request."}',
		scope: "account",
	},
	{
		name: "Kimi subscription without access",
		text: "403: Your current subscription does not have access to Kimi Code right now.",
		scope: "account",
	},
	{
		name: "Antigravity unsupported location",
		text: "400 FAILED_PRECONDITION: User location is not supported for the API use.",
		scope: "account",
	},
	{ name: "Antigravity account verification", text: "403: Verify your account to continue", scope: "account" },
] as const;

const throttles = ["429 Rate limit reached for requests", "503 Our servers are currently overloaded"];

describe("senpi#3350 entitlement refusals are terminal and bind the account", () => {
	it.each(refusals)("$name is not retried on the same model", ({ text }) => {
		expect(isRetryableAssistantError(failed(text))).toBe(false);
	});

	it.each(refusals)("$name records a usage-limit scope", ({ text, scope }) => {
		expect(usageLimitScope(text)).toBe(scope);
	});

	it.each(throttles)("real throttle %s stays retryable without a scope", (text) => {
		expect(isRetryableAssistantError(failed(text))).toBe(true);
		expect(usageLimitScope(text)).toBeUndefined();
	});
});
