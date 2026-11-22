import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: only the #3811 engine admission hook owns the durable human revision.
const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it("increments exactly once for a human steer on a held session", async () => {
	// Given a held session and the real exactly-once admission hook.
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		persistSession: true,
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.lifecycle).toMatchObject({ state: "held", humanInputRevision: 0 });
	h.setResponses([fauxAssistantMessage("Continuing with the human's instruction.")]);

	// When steer delegates through the held session's prompt path.
	await runToAgentIdle(h, () => h.session.steer("Continue with this instruction"));

	// Then delegation cannot charge the same human input twice.
	expect(h.session.lifecycle).toMatchObject({ humanInputRevision: 1, epochOrigin: "human" });
});

it("does not count an extension delivery as human admission", async () => {
	// Given an epoch completed by a human prompt.
	const h = await createHarness();
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("First reply."), fauxAssistantMessage("Automatic follow-up.")]);
	await runToAgentIdle(h, () => h.session.prompt("Human request"));
	expect(h.session.lifecycle).toMatchObject({ humanInputRevision: 1 });

	// When an extension-origin user message, with no pending question answer, starts the next turn.
	await runToAgentIdle(h, () => h.session.sendUserMessage("An automatic extension delivery"));

	// Then the message role cannot impersonate human admission.
	expect(h.session.lifecycle).toMatchObject({ humanInputRevision: 1, epochOrigin: "automatic" });
});

it("fails self-settle eligibility closed when the revision cannot be persisted", async () => {
	// Given a real persisted session with a write failure at the lifecycle boundary.
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.lifecycle).toBeDefined();
	const append = h.sessionManager.appendCustomEntry.bind(h.sessionManager);
	vi.spyOn(h.sessionManager, "appendCustomEntry").mockImplementation((type, data, options) => {
		if (type === "session-lifecycle") throw new Error("Synthetic lifecycle write failure");
		return append(type, data, options);
	});
	h.setResponses([fauxAssistantMessage("The human input still runs.")]);

	// When the admission hook cannot durably record the human revision.
	await runToAgentIdle(h, () => h.session.prompt("Human request"));

	// Then the epoch cannot authorize self-settle even though input was not blocked.
	expect(h.session.lifecycle).toMatchObject({ humanInputRevision: 1, selfSettleEligible: false, persisted: false });
});
