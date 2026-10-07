import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

const USAGE_LIMITS: ReadonlyArray<readonly [string, string]> = [
	["Claude session limit", "You've hit your session limit · resets 3pm (Asia/Seoul)"],
	["Claude weekly limit", "You've hit your weekly limit · resets 5am (Asia/Seoul)"],
	["Claude model weekly limit", "You've hit your Fable weekly limit · resets Oct 2, 9am"],
	["Claude blocking_limit terminal reason", "Claude Code error_during_execution: blocking_limit"],
	[
		"every Claude account blocked",
		"All Claude accounts for anthropic-subscription are currently blocked (rate limit or auth errors).\n  Soonest automatic retry: 2026-09-30T06:00:00.000Z.\n  /claude-account list  - inspect account states\n  /login anthropic-subscription  - add another account",
	],
	["Codex usage limit", '429 {"type":"usage_limit_reached","message":"The usage limit has been reached"}'],
	[
		"Copilot quota",
		"GitHub Copilot quota exceeded (HTTP 429): the plan's included usage or its additional-usage limit is used up, so premium models are refused until it resets or the limit is raised.",
	],
	["OpenCode Go monthly limit", "429 Monthly usage limit reached. It will reset in 2 days 8 hours"],
	["Z.AI weekly/monthly exhaustion", "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-30 00:00:00"],
	[
		"Devin free model limit",
		"Devin stream error resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 9 minutes (at 16:56 UTC).",
	],
];

function errorTurn(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

describe("usage-limit failures move to the next fallback model", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	for (const [label, errorMessage] of USAGE_LIMITS) {
		it(`#given ${label} on the primary #when the turn fails #then the fallback model answers it`, async () => {
			const harness = await createHarness({
				models: [{ id: "faux-1" }, { id: "faux-2" }],
				fallbackNow: () => 0,
				settings: {
					retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
				},
			});
			harnesses.push(harness);
			harness.setResponses([errorTurn(errorMessage), fauxAssistantMessage("fallback answer")]);

			await harness.session.prompt("hello");

			expect({
				models: harness.faux.getCallLog().map((call) => call.modelId),
				applied: harness.eventsOfType("retry_fallback_applied").map((event) => [event.from, event.to]),
			}).toEqual({ models: ["faux-1", "faux-2"], applied: [[primary, fallback]] });
		});
	}
});
