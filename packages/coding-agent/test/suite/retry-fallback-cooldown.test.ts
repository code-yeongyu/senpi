import { describe, expect, it } from "vitest";
import { SelectorCooldowns } from "../../src/core/retry-fallback/cooldown.ts";

describe("SelectorCooldowns", () => {
	it("prefers a positive provider retry-after duration", () => {
		let time = 1_000;
		const cooldowns = new SelectorCooldowns(() => time);

		cooldowns.note("anthropic/claude", { retryAfterMs: 5_000, errorMessage: "quota exceeded" });

		time += 4_999;
		expect(cooldowns.isSuppressed("anthropic/claude")).toBe(true);
		time += 1;
		expect(cooldowns.isSuppressed("anthropic/claude")).toBe(false);
	});

	it.each([
		["usage limits", "usage limit reached", 30 * 60_000],
		["quota", "insufficient_quota", 30 * 60_000],
		["billing", "Billing limit reached", 30 * 60_000],
		["rate limit", "rate limit exceeded", 30_000],
		["HTTP 429", "HTTP 429", 30_000],
		["too many requests", "Too Many Requests", 30_000],
		["overloaded", "service overloaded", 45_000],
		["capacity", "capacity unavailable", 45_000],
		["5xx", "HTTP 503", 20_000],
		["server", "server error", 20_000],
		["internal", "internal error", 20_000],
		["unknown", undefined, 5 * 60_000],
		["empty", "", 5 * 60_000],
	])("uses the %s duration class", (_name, errorMessage, durationMs) => {
		let time = 0;
		const cooldowns = new SelectorCooldowns(
			() => time,
			() => 0,
		);

		cooldowns.note("openai/gpt", { errorMessage });

		time = durationMs - 1;
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(true);
		time = durationMs;
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(false);
	});

	it("adds deterministic jitter of up to 30 seconds for overloaded capacity", () => {
		let time = 0;
		const cooldowns = new SelectorCooldowns(
			() => time,
			() => 1,
		);

		cooldowns.note("openai/gpt", { errorMessage: "capacity exhausted" });

		time = 74_999;
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(true);
		time = 75_000;
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(false);
	});

	it("evicts expired selectors lazily at the expiry boundary", () => {
		let time = 0;
		const cooldowns = new SelectorCooldowns(() => time);

		cooldowns.note("openai/gpt", { retryAfterMs: 100 });
		time = 99;
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(true);
		time = 100;
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(false);
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(false);
	});

	it("clears one selector or every selector", () => {
		const cooldowns = new SelectorCooldowns(() => 0);
		cooldowns.note("anthropic/claude", { retryAfterMs: 100 });
		cooldowns.note("openai/gpt", { retryAfterMs: 100 });

		cooldowns.clear("anthropic/claude");
		expect(cooldowns.isSuppressed("anthropic/claude")).toBe(false);
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(true);

		cooldowns.clearAll();
		expect(cooldowns.isSuppressed("openai/gpt")).toBe(false);
	});
});
