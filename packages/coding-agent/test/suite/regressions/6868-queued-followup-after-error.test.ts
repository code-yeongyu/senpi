import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { handleClientInput } from "../../../src/modes/rpc/client-input-handler.ts";
import type { EffectStatus } from "../../../src/modes/rpc/effect-record.ts";
import { installSessionEffectSink } from "../../../src/modes/rpc/session-effect-status.ts";
import { createHarness, getMessageText } from "../harness.ts";

const FOLLOW_UP = "answer this follow-up";
const INPUT_ID = "queued-follow-up";
const ACCOUNT_LIMIT =
	'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';

// senpi#6868: an acknowledged RPC follow-up must leave the idle queue after a provider error, but not a user abort.
describe("#6868 follow-ups queued during a failed turn", () => {
	it.each([
		{
			name: "starts its own turn after a terminal provider error",
			failure: fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "invalid_request_error: the request was malformed",
			}),
			expected: "started",
		},
		{
			name: "fails without another request when the account is held",
			failure: fauxAssistantMessage("", { stopReason: "error", errorMessage: ACCOUNT_LIMIT }),
			expected: "failed",
		},
		{
			name: "stays queued after a user abort",
			failure: fauxAssistantMessage("", { stopReason: "aborted" }),
			expected: "queued",
		},
	])("$name", async ({ failure, expected }) => {
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			fallbackNow: () => 0,
		});
		const { session } = harness;
		const statuses: EffectStatus[] = [];
		const unsubscribe = installSessionEffectSink({
			owns: (target) => target === session,
			flush: (_target, effects) => statuses.push(...effects),
		});
		const requested = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				requested.resolve();
				await release.promise;
				return failure;
			},
			fauxAssistantMessage("follow-up answered"),
		]);

		const first = session.prompt("first request");
		try {
			await requested.promise;
			const output: object[] = [];
			await handleClientInput(
				session,
				{ type: "prompt", message: FOLLOW_UP, streamingBehavior: "followUp", clientMessageId: INPUT_ID },
				{ output: (record) => output.push(record), promptCalls: new Set() },
			);
			expect(output).toMatchObject([{ success: true, data: { disposition: "queued" } }]);
			expect(session.pendingMessageCount).toBe(1);

			const abort = expected === "queued" ? session.abort() : undefined;
			release.resolve();
			await abort;
			await first;
			await session.waitForIdle();
			await session.waitForSettledSessionWork();

			const calls = harness.faux.getCallLog();
			const inputStatuses = statuses.filter((status) => status.effectId === INPUT_ID);
			expect(session.isIdle).toBe(true);
			if (expected === "started") {
				expect(calls.map((call) => getMessageText(call.context.messages.at(-1)))).toEqual([
					"first request",
					FOLLOW_UP,
				]);
				expect(session.pendingMessageCount).toBe(0);
				expect(inputStatuses.map(({ state }) => state)).toEqual(["accepted", "applied", "done"]);
			} else if (expected === "failed") {
				expect(calls).toHaveLength(1);
				expect(session.pendingMessageCount).toBe(0);
				expect(inputStatuses.at(-1)).toMatchObject({
					state: "failed",
					disposition: "rejected",
					outcome: { kind: "refused", reason: "account_usage_limit", detail: expect.stringContaining("11pm") },
				});
				expect((await session.getPendingInputs()).inputs).toMatchObject([
					{
						clientMessageId: INPUT_ID,
						state: "failed",
						failure: { delivery: "not_delivered", code: "account_usage_limit" },
					},
				]);
			} else {
				expect(calls).toHaveLength(1);
				expect(session.pendingMessageCount).toBe(1);
				expect(inputStatuses.map(({ state }) => state)).toEqual(["accepted"]);
			}
		} finally {
			release.resolve();
			await first;
			unsubscribe();
			harness.cleanup();
		}
	});

	// senpi#6868 review: under a #3131 hold only input a sender waits on is refused, and a refused peer delivery is not
	// booked as a session-file refusal (which made its redelivery answer `already_admitted`).
	it.each([
		{ name: "a refused peer delivery leaves no failed admission, so its sender can redeliver it", input: "peer" },
		{ name: "a person's follow-up without a client id stays queued", input: "person" },
	] as const)("under an account hold, $name", async ({ input }) => {
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			fallbackNow: () => 0,
		});
		const { session } = harness;
		const requested = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				requested.resolve();
				await release.promise;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: ACCOUNT_LIMIT });
			},
			fauxAssistantMessage("must not be requested"),
		]);

		const first = session.prompt("first request");
		try {
			await requested.promise;
			if (input === "peer") {
				expect(
					session.externalAdmission.admit({ delivery_id: "peer-1", text: FOLLOW_UP, deliverAs: "followUp" }),
				).toMatchObject({ kind: "queued" });
			} else {
				await session.prompt(FOLLOW_UP, { streamingBehavior: "followUp" });
			}
			expect(session.agent.hasQueuedMessages()).toBe(true);

			release.resolve();
			await first;
			await session.waitForIdle();
			await session.waitForSettledSessionWork();

			expect(harness.faux.getCallLog()).toHaveLength(1);
			if (input === "peer") {
				expect(session.agent.hasQueuedMessages()).toBe(false);
				expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: [] });
			} else {
				expect(session.getFollowUpMessages()).toEqual([FOLLOW_UP]);
			}
		} finally {
			release.resolve();
			await first;
			harness.cleanup();
		}
	});
});
