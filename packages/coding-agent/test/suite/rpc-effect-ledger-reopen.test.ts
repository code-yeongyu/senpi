import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EFFECT_OUTCOMES } from "../../src/modes/rpc/effect-outcome-copy.ts";
import { effectFingerprint, RPC_EFFECT_ENTRY } from "../../src/modes/rpc/effect-record.ts";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;

// Ledger-only reopen seals for the kinds whose commands land in later changes (unload, dequeue): the
// entries are written as a process that died mid-effect leaves them, then the transcript is reopened.
describe("RPC effect ledger reopen seal", () => {
	const fixtures: Fixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});
	const leaveEffect = (fixture: Fixture, effectId: string, kind: "unload" | "dequeue", state: string) =>
		fixture.session.sessionManager.appendCustomEntry(RPC_EFFECT_ENTRY, {
			effectId,
			kind,
			state,
			by: { connectionId: "gone" },
			acceptedAt: "2026-10-12T00:00:00.000Z",
			updatedAt: "2026-10-12T00:00:00.000Z",
			durableSessionId: fixture.session.sessionManager.getSessionId(),
			fingerprint: effectFingerprint(kind, {}),
		});

	it("seals an applied unload as done", async () => {
		// Given
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		await fixture.bind().handler.ready;
		await fixture.session.sessionManager.persistHeaderNow();
		leaveEffect(fixture, "u1", "unload", "applied");

		// When
		const reopened = await fixture.reopen();
		const status = await reopened.send({ type: "get_effect_status", effectId: "u1" });

		// Then
		expect(status).toMatchObject({ data: { found: true, effect: { kind: "unload", state: "done" } } });
	});

	it("fails an accepted dequeue and still restores the queued input it targeted", async () => {
		// Given: a queued follow-up and a dequeue of it that never finished.
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("one")]);
		const rpc = fixture.bind();
		await rpc.send({ type: "follow_up", message: "kept", clientMessageId: "q1" });
		leaveEffect(fixture, "d1", "dequeue", "accepted");

		// When
		const reopened = await fixture.reopen();
		const status = await reopened.send({ type: "get_effect_status", effectId: "d1" });
		const state = await reopened.send({ type: "get_state" });

		// Then
		expect(status).toMatchObject({
			data: { effect: { kind: "dequeue", state: "failed", outcome: EFFECT_OUTCOMES.dequeueInterruptedByReopen } },
		});
		expect(state).toMatchObject({ data: { ordered: [{ clientMessageId: "q1", text: "kept" }] } });
	});
});
