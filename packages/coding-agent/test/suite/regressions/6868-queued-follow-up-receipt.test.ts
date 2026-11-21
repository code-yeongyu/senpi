import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

const FOLLOW_UP = "follow-up an RPC client queued during the held turn";
const ACCOUNT_LIMIT =
	'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';

describe("#6868 an RPC follow-up a provider hold refused after an error turn", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	it("#given a follow-up an RPC client queued during a turn #when that turn ends on a spent-account limit #then its receipt reads failed with the typed refusal and the wire carries queued_input_failed", async () => {
		// given
		const fixture = await createIdentityHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } },
			fallbackNow: () => Date.now(),
			retryRandom: () => 0,
		});
		fixtures.push(fixture);
		const rpc = fixture.bind();
		let queued: unknown;
		fixture.harness.setResponses([
			async () => {
				// Admitted while this run is still streaming, so it is queued behind it (an idle session's follow_up
				// queues for the next prompt by design and never meets this run's end).
				queued = await rpc.send({ type: "follow_up", message: FOLLOW_UP, clientMessageId: "held-1" });
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: ACCOUNT_LIMIT });
			},
			fauxAssistantMessage("must not run while the account is held"),
		]);

		// when
		await rpc.send({ type: "prompt", message: "a turn that hits the account limit", clientMessageId: "turn-1" });
		await Promise.all(rpc.handler.pendingPrompts());
		await fixture.session.waitForIdle();
		await fixture.session.waitForSettledSessionWork();
		const status = await rpc.send({ type: "get_effect_status", effectId: "held-1" });

		// then
		expect(queued).toMatchObject({ success: true, data: { admission: { disposition: "queued" } } });
		expect(status).toMatchObject({
			success: true,
			data: {
				found: true,
				effect: { state: "failed", outcome: { kind: "refused", reason: "account_usage_limit" } },
			},
		});
		expect(
			rpc.messages().some((record) => record.type === "queued_input_failed" && record.clientMessageId === "held-1"),
		).toBe(true);
		expect(fixture.harness.faux.getCallLog()).toHaveLength(1);
	});
});
