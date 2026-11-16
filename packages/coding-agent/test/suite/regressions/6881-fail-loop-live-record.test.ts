import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createHarness, type Harness } from "../harness.ts";

const ACCOUNT_LIMIT =
	'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';

type Refusal = Extract<AgentSessionEvent, { type: "queued_input_failed" }>;

/**
 * Two follow-ups queued during a turn that ends on a spent account, so the session fails both; `onFirstRefusal` runs
 * inside the first refusal's listener, before that input's dequeue and before the second input is decided.
 */
async function heldTurnWithTwoFollowUps(
	harnesses: Harness[],
	onFirstRefusal: (harness: Harness) => void,
): Promise<{ readonly harness: Harness; readonly refusals: Refusal[] }> {
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
		fallbackNow: () => Date.now(),
		retryRandom: () => 0,
	});
	harnesses.push(harness);
	const queued: Promise<void>[] = [];
	harness.setResponses([
		() => {
			queued.push(harness.session.prompt("first follow-up", { streamingBehavior: "followUp", source: "rpc" }));
			queued.push(harness.session.prompt("second follow-up", { streamingBehavior: "followUp", source: "rpc" }));
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: ACCOUNT_LIMIT });
		},
		fauxAssistantMessage("must not run while the account is held"),
	]);
	const refusals: Refusal[] = [];
	harness.session.subscribe((event) => {
		if (event.type !== "queued_input_failed") return;
		refusals.push(event);
		if (refusals.length === 1) onFirstRefusal(harness);
	});
	await harness.session.prompt("a turn that hits the account limit").catch(() => undefined);
	await Promise.all(queued);
	await harness.session.waitForIdle();
	await harness.session.waitForSettledSessionWork();
	return { harness, refusals };
}

describe("#6881 the session's held follow-up fail loop reads each input's live record", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given two held follow-ups #when the queue is cleared inside the first refusal #then the cleared second one gets no refusal", async () => {
		// when
		const { harness, refusals } = await heldTurnWithTwoFollowUps(harnesses, (held) => {
			held.session.clearQueue();
		});

		// then
		expect(refusals.map((refusal) => refusal.text)).toEqual(["first follow-up"]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("#given two held follow-ups #when the second is edited inside the first refusal #then its refusal carries the edited text", async () => {
		// when
		const { harness, refusals } = await heldTurnWithTwoFollowUps(harnesses, (held) => {
			const second = held.session.getQueuedInputs().find((input) => input.text === "second follow-up");
			if (second === undefined) throw new Error("the second follow-up is not queued");
			expect(held.session.editQueuedInput(second.queuedId, "second follow-up, edited")).toBe("edited");
		});

		// then
		expect(refusals.map((refusal) => refusal.text)).toEqual(["first follow-up", "second follow-up, edited"]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});
