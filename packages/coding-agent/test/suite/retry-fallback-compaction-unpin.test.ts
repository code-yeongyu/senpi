import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const nextFallback = "faux/faux-3";

function refusal(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(text, {
		stopReason: "error",
		errorMessage: "misleading_success_output",
		stopDetails: { type: "refusal" },
	});
}

// Verbatim provider error captured from a real session (2026-07-28, anthropic-api
// claude-fable-5): the billing class whose pins compaction must never release.
const creditBalanceError =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CdUDPLwbT8EDXCxMJBvQy"}';

const billingError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: creditBalanceError });
const transientError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

interface FallbackStateView {
	pinned: boolean;
	pinnedByRefusal: boolean;
	pinnedByBilling: boolean;
}

interface ControllerApi {
	activeState: Readonly<FallbackStateView> | undefined;
	notifyCompactionApplied(): boolean;
}

function controller(harness: Harness): ControllerApi {
	return (harness.session as unknown as { _retryFallback: ControllerApi })._retryFallback;
}

function fallbackState(harness: Harness): FallbackStateView | undefined {
	return controller(harness).activeState;
}

function fallbackLogLines(harness: Harness): string[] {
	try {
		return readFileSync(join(harness.tempDir, "agent", "logs", "fallback.log"), "utf8")
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}

function refusalReleaseLines(harness: Harness): string[] {
	return fallbackLogLines(harness).filter((line) => line.includes('"event":"refusal_pin_released"'));
}

describe("retry fallback compaction unpin", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("(1) releases a refusal pin on compaction and lets the existing cooldown-expiry restore fire", async () => {
		const now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([refusal("primary refusal"), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");
		expect(harness.session.model?.id).toBe("faux-2");
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByRefusal: true, pinnedByBilling: false });

		expect(controller(harness).notifyCompactionApplied()).toBe(true);
		expect(fallbackState(harness)).toMatchObject({ pinned: false, pinnedByRefusal: false, pinnedByBilling: false });

		// The unpin alone must make the existing turn-boundary gate restore the primary.
		harness.setResponses([fauxAssistantMessage("primary answer")]);
		await harness.session.prompt("post-compaction");

		const reverted = harness.eventsOfType("retry_fallback_reverted");
		expect(reverted).toHaveLength(1);
		expect(reverted[0]).toMatchObject({ from: fallback, to: primary });
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.faux.getCallLog().at(-1)?.modelId).toBe("faux-1");
		expect(fallbackState(harness)).toBeUndefined();
		expect(refusalReleaseLines(harness)).toHaveLength(1);
		const releaseLine = refusalReleaseLines(harness)[0];
		expect(releaseLine).toContain(`"chainKey":"${primary}"`);
		expect(releaseLine).toContain(`"originalSelector":"${primary}"`);
		expect(releaseLine).toContain('"trigger":"compaction"');
	});

	it("(2) never releases a billing pin and keeps refusing the restore", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([billingError(), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.reason)).toEqual(["billing"]);
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByRefusal: false, pinnedByBilling: true });

		expect(controller(harness).notifyCompactionApplied()).toBe(false);
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByBilling: true });
		expect(refusalReleaseLines(harness)).toHaveLength(0);

		// Far past the 30-minute billing cooldown: the billing contribution must hold.
		now += 31 * 60_000;
		harness.setResponses([fauxAssistantMessage("still fallback")]);
		await harness.session.prompt("second");
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-2");
	});

	it("(3) holds the pin when billing compounds an earlier refusal", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback, nextFallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([refusal("primary refusal"), billingError(), fauxAssistantMessage("next answer")]);

		await harness.session.prompt("hello");
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.reason)).toEqual([
			"refusal",
			"billing",
		]);
		expect(harness.session.model?.id).toBe("faux-3");
		expect(fallbackState(harness)).toMatchObject({
			pinned: true,
			pinnedByRefusal: true,
			pinnedByBilling: true,
		});

		// The refusal contribution clears but the billing contribution keeps the pin.
		expect(controller(harness).notifyCompactionApplied()).toBe(false);
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByBilling: true });
		expect(refusalReleaseLines(harness)).toHaveLength(0);

		now += 31 * 60_000;
		harness.setResponses([fauxAssistantMessage("still next")]);
		await harness.session.prompt("second");
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-3");
	});

	it('(4) unpins under revertPolicy "never" but still refuses the restore', async () => {
		const now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
					fallbackRevertPolicy: "never",
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([refusal("primary refusal"), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");
		expect(harness.session.model?.id).toBe("faux-2");

		expect(controller(harness).notifyCompactionApplied()).toBe(true);
		expect(fallbackState(harness)).toMatchObject({ pinned: false, pinnedByRefusal: false });

		harness.setResponses([fauxAssistantMessage("fallback again")]);
		await harness.session.prompt("second");
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.faux.getCallLog()[2]?.modelId).toBe("faux-2");
	});

	it("(5) is a no-op without active fallback state and writes no release log", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		// A transient fallback that reverts leaves no active state but does leave a
		// populated fallback.log, so the "no release log" check is meaningful.
		harness.setResponses([transientError(), fauxAssistantMessage("fallback answer")]);
		await harness.session.prompt("hello");
		expect(harness.session.model?.id).toBe("faux-2");

		now += 10 * 60_000; // past the 45s(+jitter) transient cooldown
		harness.setResponses([fauxAssistantMessage("primary back")]);
		await harness.session.prompt("second");
		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(1);
		expect(fallbackState(harness)).toBeUndefined();

		expect(controller(harness).notifyCompactionApplied()).toBe(false);
		expect(refusalReleaseLines(harness)).toHaveLength(0);
	});

	it("(6) re-pins when the restored primary refuses again", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => 0,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			refusal("primary refusal"),
			fauxAssistantMessage("fallback answer"),
			refusal("primary refusal again"),
			fauxAssistantMessage("fallback answer again"),
		]);

		await harness.session.prompt("hello");
		expect(controller(harness).notifyCompactionApplied()).toBe(true);

		// The restore puts the primary back, its second refusal re-enters the
		// existing refusal path: one fresh primary attempt per compaction, no ping-pong.
		await harness.session.prompt("second");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "refusal" },
			{ from: primary, to: fallback, reason: "refusal" },
		]);
		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(1);
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByRefusal: true, pinnedByBilling: false });
	});
});
