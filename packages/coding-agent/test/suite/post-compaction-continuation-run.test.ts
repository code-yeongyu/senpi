import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getUserTexts, type Harness } from "./harness.ts";
import { expectWithin, heldResponse, startPostCompactionContinuation } from "./post-compaction-continuation-rig.ts";

describe("post-compaction continuation is an active run (senpi#6345)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reports the resumed continuation as streaming for its whole duration", async () => {
		const rig = await startPostCompactionContinuation(harnesses);
		const { session } = rig.harness;

		expect(session.isStreaming).toBe(true);
		expect(session.currentTurnId).toBeDefined();
		expect(rig.samples.length).toBeGreaterThan(0);

		rig.continuation.release();
		await expectWithin(rig.continuationEnded, 2_000, "the continuation finishes");
		await expectWithin(rig.activePrompt, 2_000, "the aborted prompt settles");
		await session.waitForSettledSessionWork();

		expect(rig.samples.every(Boolean), `isStreaming samples: ${rig.samples.join(",")}`).toBe(true);
		expect(session.isStreaming).toBe(false);
	});

	it("queues a prompt submitted during the continuation at once instead of waiting for it to end", async () => {
		const rig = await startPostCompactionContinuation(harnesses);
		const { session } = rig.harness;
		rig.harness.appendResponses([fauxAssistantMessage("after the typed steer")]);

		const typed = session.prompt("typed during the continuation", { streamingBehavior: "steer" });
		await expectWithin(typed, 500, "a steer is queued while the continuation still runs");
		expect(session.getSteeringMessages()).toContain("typed during the continuation");

		rig.continuation.release();
		await expectWithin(typed, 2_000, "the typed prompt settles");
		await expectWithin(rig.activePrompt, 2_000, "the aborted prompt settles");
		await session.waitForSettledSessionWork();
		expect(getUserTexts(rig.harness)).toContain("typed during the continuation");
		expect(session.isStreaming).toBe(false);
	});

	it("lets abort() stop the continuation as a mid-run user stop that does not continue with queued input", async () => {
		const rig = await startPostCompactionContinuation(harnesses);
		const { session } = rig.harness;
		const after = heldResponse("must not run after the stop");
		rig.harness.appendResponses([after.step]);
		rig.pi.sendMessage(
			{ customType: "queued-note", content: "notification queued during the continuation", display: false },
			{ deliverAs: "steer" },
		);

		const gapAbortsBefore = rig.harness.eventsOfType("session_abort").length;
		await expectWithin(session.abort(), 2_000, "abort() returns once the continuation stopped");
		await expectWithin(rig.continuationEnded, 2_000, "the continuation ends");
		await expectWithin(rig.activePrompt, 2_000, "the aborted prompt settles");
		await session.waitForSettledSessionWork();

		const continuationEnd = rig.harness.eventsOfType("agent_end").at(-1);
		expect(continuationEnd?.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(after.calls(), "a user stop must not start another request for the queued input").toBe(0);
		expect(
			rig.harness.eventsOfType("session_abort").length - gapAbortsBefore,
			"a stop during the continuation is a mid-run stop carried by its agent_end, not a gap abort",
		).toBe(0);
		expect(session.isStreaming).toBe(false);
		after.release();
	});
});
