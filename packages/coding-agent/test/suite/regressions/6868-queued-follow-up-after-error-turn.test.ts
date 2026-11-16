import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createHarness, type Harness } from "../harness.ts";

const FOLLOW_UP = "follow-up a remote sender queued during the failing turn";
const HARD_ERROR = "invalid_request_error: the request was malformed";
const ACCOUNT_LIMIT =
	'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';
// Bounds the wait only; a sender whose follow-up is parked never resolves on its own.
const WAIT_BOUND_MS = 10_000;

type SenderOutcome =
	| { readonly kind: "started"; readonly answer: string }
	| { readonly kind: "failed"; readonly code: string; readonly provider: string }
	| { readonly kind: "still_waiting" };

/**
 * What a remote sender waiting on its queued prompt sees from the session's records (the records an RPC client
 * receives): its prompt's own turn settling with an answer, or a typed failure for that queued input.
 * Subscribed before the turn starts, so no record can be missed.
 */
function senderWait(harness: Harness, text: string): Promise<SenderOutcome> {
	return new Promise((resolve) => {
		let ownTurn = false;
		let answer = "";
		const done = (outcome: SenderOutcome) => {
			clearTimeout(bound);
			unsubscribe();
			resolve(outcome);
		};
		const bound = setTimeout(() => done({ kind: "still_waiting" }), WAIT_BOUND_MS);
		const unsubscribe = harness.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "queued_input_failed" && event.text === text)
				return done({ kind: "failed", code: event.error.code, provider: event.error.provider });
			if (event.type === "message_end" && event.message.role === "user") {
				const content = event.message.content;
				const said =
					typeof content === "string"
						? content
						: content.map((part) => ("text" in part ? part.text : "")).join("");
				if (said === text) ownTurn = true;
				return;
			}
			if (ownTurn && event.type === "message_end" && event.message.role === "assistant") {
				answer = event.message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				return;
			}
			if (ownTurn && event.type === "agent_settled") done({ kind: "started", answer });
		});
	});
}

async function settle(harness: Harness): Promise<void> {
	await harness.session.waitForIdle();
	await harness.session.waitForSettledSessionWork();
}

describe("#6868 a follow-up queued behind a turn that ended in a provider error", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given a follow-up queued during a turn #when that turn ends in a provider error with no account hold #then the follow-up starts its own turn and the waiting sender resolves with its answer", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		let queued: Promise<void> | undefined;
		harness.setResponses([
			() => {
				queued = harness.session.prompt(FOLLOW_UP, { streamingBehavior: "followUp", source: "rpc" });
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: HARD_ERROR });
			},
			fauxAssistantMessage("answered the follow-up"),
			fauxAssistantMessage("unexpected extra turn"),
		]);
		const waited = senderWait(harness, FOLLOW_UP);

		// when
		await harness.session.prompt("a turn that fails").catch(() => undefined);
		await queued;
		const outcome = await waited;
		await settle(harness);

		// then
		expect(outcome).toEqual({ kind: "started", answer: "answered the follow-up" });
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.getCallLog()).toHaveLength(2);
	});

	it("#given a follow-up queued during a turn #when that turn ends on a spent-account rate limit #then the follow-up never reaches the held provider and the waiting sender resolves with a typed failure naming the hold", async () => {
		// given
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
			fallbackNow: () => Date.now(),
			retryRandom: () => 0,
		});
		harnesses.push(harness);
		let queued: Promise<void> | undefined;
		harness.setResponses([
			() => {
				queued = harness.session.prompt(FOLLOW_UP, { streamingBehavior: "followUp", source: "rpc" });
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: ACCOUNT_LIMIT });
			},
			fauxAssistantMessage("must not run while the account is held"),
		]);
		const waited = senderWait(harness, FOLLOW_UP);

		// when
		await harness.session.prompt("a turn that hits the account limit").catch(() => undefined);
		await queued;
		const outcome = await waited;
		await settle(harness);

		// then
		expect(outcome).toEqual({ kind: "failed", code: "account_usage_limit", provider: "faux" });
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("#given a follow-up queued during a turn #when the person aborts that turn #then the follow-up still waits for the next prompt", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		const turnRunning = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let queued: Promise<void> | undefined;
		harness.setResponses([
			async () => {
				queued = harness.session.prompt(FOLLOW_UP, { streamingBehavior: "followUp", source: "rpc" });
				turnRunning.resolve();
				await release.promise;
				return fauxAssistantMessage("aborted response");
			},
			fauxAssistantMessage("unexpected turn after the abort"),
		]);

		// when
		const turn = harness.session.prompt("a turn the person aborts").catch(() => undefined);
		await turnRunning.promise;
		await queued;
		await harness.session.abort();
		release.resolve();
		await turn;
		await settle(harness);

		// then
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});
