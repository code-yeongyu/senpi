import { describe, expect, it } from "vitest";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";
import { usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";

// senpi#3349: Z.ai 1310/1113 carried `429` and got the 30 s rate-limit hold, and Antigravity's
// individual quota and Z.ai's insufficient balance were never scoped as usage limits.

const ZAI_1310 =
	'429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-20 08:00:00"}';
const ZAI_1113 = '429: {"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}';
const ANTIGRAVITY_INDIVIDUAL_QUOTA =
	'Antigravity request failed: HTTP 429 {"error":{"code":429,"message":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h9m10s. [Debug Info] Requested Model: antigravity-gemini-3.8-flash","status":"RESOURCE_EXHAUSTED"}}';

function expectHold(errorMessage: string, durationMs: number): void {
	let time = 0;
	const cooldowns = new SelectorCooldowns(
		() => time,
		() => 0,
	);
	cooldowns.note("zai/glm", { errorMessage });
	time = durationMs - 1;
	expect(cooldowns.isSuppressed("zai/glm")).toBe(true);
	time = durationMs;
	expect(cooldowns.isSuppressed("zai/glm")).toBe(false);
}

describe("senpi#3349 long limits get long holds", () => {
	it.each([
		["Z.ai 1310 weekly/monthly limit exhausted", ZAI_1310],
		["Z.ai 1113 insufficient balance", ZAI_1113],
	])("%s gets the 30-minute usage hold", (_name, errorMessage) => {
		expectHold(errorMessage, 30 * 60_000);
	});

	it.each([
		["plain 429", "HTTP 429"],
		["rate limit exceeded", "rate limit exceeded"],
		["rate limit exhausted", "429 rate limit exhausted, retry shortly"],
	])("%s keeps the 30-second rate-limit hold", (_name, errorMessage) => {
		expectHold(errorMessage, 30_000);
	});

	it.each([
		["Z.ai 1310", ZAI_1310, "account"],
		["Z.ai 1113", ZAI_1113, "account"],
		["Antigravity individual quota", ANTIGRAVITY_INDIVIDUAL_QUOTA, "model"],
	] as const)("%s is scoped as a usage limit", (_name, errorMessage, scope) => {
		expect(usageLimitScope(errorMessage)).toBe(scope);
	});

	it.each([
		["plain 429", "HTTP 429"],
		["rate limit exceeded", "rate limit exceeded"],
		["rate limit exhausted", "429 rate limit exhausted, retry shortly"],
	])("%s stays unscoped", (_name, errorMessage) => {
		expect(usageLimitScope(errorMessage)).toBeUndefined();
	});
});
