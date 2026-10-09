import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SENPI_DEFAULT_RETRY_PROFILE } from "@earendil-works/pi-ai/utils/retry-profile/profiles";
import { afterEach, describe, expect, it } from "vitest";
import { isBillingErrorMessage } from "../../src/core/retry-fallback/billing.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

// Verbatim provider error captured from a real session (2026-07-28, anthropic-api
// claude-fable-5): the billing class this behavior targets.
const creditBalanceError =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CdUDPLwbT8EDXCxMJBvQy"}';
// Verbatim provider error captured from a real session (2026-07-29, anthropic
// claude-fable-5): Anthropic Console credit exhaustion arrives as a 429
// rate_limit_error carrying error_code credits_required.
const creditsRequiredError =
	'429 event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required","model":"claude-fable-5"}},"request_id":"req_011CdW2nFxprAx6KQ9JhnAvq"}';
const terminalNonBillingError = "Error: provider rejected the request permanently";
// Verbatim provider error observed on a dead OpenAI account (senpi#1969): hard
// account-quota exhaustion arrives as a 429 usage_limit_reached.
const usageLimitExhaustedError =
	'OpenAI API error (429): {"type":"usage_limit_reached","message":"The usage limit has been reached"}';

const billingError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: creditBalanceError });
const creditsRequiredBillingError = () =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: creditsRequiredError });
const usageLimitBillingError = () =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimitExhaustedError });
const hardError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: terminalNonBillingError });

function createChainHarness(now: () => number, maxRetries = 0): Promise<Harness> {
	return createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		fallbackNow: now,
		settings: {
			retry: { enabled: true, maxRetries, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
		},
	});
}

describe("retry fallback billing swap", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("pins a credit-balance fallback as the session model for the rest of the session", async () => {
		let now = 0;
		const harness = await createChainHarness(() => now);
		harnesses.push(harness);
		harness.setResponses([
			billingError(),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("still fallback"),
		]);

		await harness.session.prompt("first");

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.reason)).toEqual(["billing"]);

		// Far past the 30-minute billing cooldown: a temporary fallback would revert
		// here; the pinned swap must hold the fallback model for the rest of the session.
		now += 31 * 60_000;
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-2"]);
	});

	it("pins an anthropic credits_required fallback instead of reverting into the dead model", async () => {
		let now = 0;
		const harness = await createChainHarness(() => now);
		harnesses.push(harness);
		harness.setResponses([
			creditsRequiredBillingError(),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("still fallback"),
		]);

		await harness.session.prompt("first");

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.reason)).toEqual(["billing"]);

		// Past every transient bucket: the credits-dead primary must stay parked
		// and the pinned fallback must hold, or cooldown-expiry reverts into a
		// model that answers the same 429 forever (2026-07-29 incident session
		// 019fac55: fable-5 -> kimi-k3 fallback reverted after 30s, thrash).
		now += 31 * 60_000;
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-2");
	});

	it("switches to the fallback on the first usage_limit_reached failure and pins it as billing", async () => {
		let now = 0;
		// 5 mirrors the senpi-default turn budget: the switch must happen on the
		// FIRST failure without spending any of that same-model budget.
		const harness = await createChainHarness(() => now, 5);
		harnesses.push(harness);
		harness.setResponses([
			usageLimitBillingError(),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("still fallback"),
		]);

		await harness.session.prompt("first");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.reason)).toEqual(["billing"]);

		// Far past every cooldown: the billing-class switch must hold the fallback for
		// the rest of the session instead of reverting into the quota-dead primary.
		now += 31 * 60_000;
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-2"]);
	});

	it("fails on the first attempt when no fallback is configured, keeping the error turn", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([usageLimitBillingError()]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		// The terminal failure keeps its assistant message shape: stopReason "error"
		// is what kept the turn eligible for a fallback chain in the first place.
		expect(harness.session.state.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: usageLimitExhaustedError,
		});
	});

	it("keeps the senpi-default fallback policy for terminal verdicts at immediate-if-eligible", () => {
		expect(SENPI_DEFAULT_RETRY_PROFILE.fallback.terminal).toBe("immediate-if-eligible");
	});

	it("keeps a non-billing hard error temporary and revertable", async () => {
		let now = 0;
		const harness = await createChainHarness(() => now);
		harnesses.push(harness);
		harness.setResponses([
			hardError(),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("primary back"),
		]);

		await harness.session.prompt("first");

		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.reason)).toEqual(["hard-error"]);

		// Unclassified errors earn the default 5-minute cooldown; after it expires the
		// unpinned hard-error fallback reverts exactly as before.
		now += 6 * 60_000;
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(1);
		expect(harness.session.model?.id).toBe("faux-1");
	});
});

describe("isBillingErrorMessage", () => {
	it.each([
		["anthropic credit balance 400", creditBalanceError, true],
		[
			"openai insufficient_quota 429",
			'429 {"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}',
			true,
		],
		["bare insufficient_quota", "billing error: insufficient_quota", true],
		["purchase credits", "Please purchase credits to continue using this API", true],
		["anthropic credits_required 429", creditsRequiredError, true],
		["credits_required error code only", '429 {"error_code":"credits_required"}', true],
		["openai usage_limit_reached 429", usageLimitExhaustedError, true],
		[
			"openai usage_not_included",
			'429 {"error":{"type":"usage_not_included","message":"This model is not included in your current plan"}}',
			true,
		],
		[
			"usage-limit approach warning is a throttle, not billing",
			"OpenAI API error (429): You are approaching your usage limit",
			false,
		],
		["generic credits wording stays non-billing", "earn bonus credits with referrals", false],
		["overloaded", "overloaded_error", false],
		["rate limit", "429 rate_limit_exceeded - retry after 30 seconds", false],
		["server error", "Error 500: internal server error", false],
		["per-minute quota is a throttle, not billing", "rate limit: requests-per-minute quota exceeded", false],
		["undefined", undefined, false],
	])("%s", (_label, message, expected) => {
		expect(isBillingErrorMessage(message)).toBe(expected);
	});
});
