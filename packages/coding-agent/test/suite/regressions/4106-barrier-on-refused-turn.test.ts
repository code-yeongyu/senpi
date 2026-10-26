import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#4106: a prompt the engine refuses must not leave its tool barrier armed.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

function interruptedSession(): SessionManager {
	const sessionManager = SessionManager.inMemory();
	const sessionId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry("session-lifecycle", {
		sessionId,
		state: "running",
		seq: 2,
		epoch: 1,
		epochOrigin: "human",
		humanInputRevision: 1,
		selfSettleEligible: true,
		runPaused: false,
		since: "2026-10-23T00:00:00.000Z",
		role: "root",
		rootSessionId: sessionId,
		persisted: true,
		runActive: true,
		epochSealed: false,
		runId: "run-1",
	});
	return sessionManager;
}

it("leaves no barrier armed when an extension prompt is refused after an interrupted run", async () => {
	// Given a restored session whose previous run was interrupted.
	const h = await createHarness({ sessionManager: interruptedSession() });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.lifecycle.waitingOn?.human).toEqual(
		expect.arrayContaining([expect.objectContaining({ kind: "interrupted_run" })]),
	);

	// When a non-person prompt that carries a tool barrier is sent.
	const refused = await h.session
		.prompt("Automatic follow-up", { source: "extension", toolBarrier: { id: "turn-1", deadlineMs: 60_000 } })
		.then(
			() => undefined,
			(error: unknown) => error,
		);

	// Then the turn is refused and the barrier it would have armed is not held.
	expect(refused).toBeInstanceOf(Error);
	expect(String(refused)).toContain("Human input or Resume is required");
	expect(h.session.releaseToolBarrier("turn-1")).toBe(false);
});

it("leaves no barrier armed when a caller callback throws after the barrier is armed", async () => {
	// Given a settled session.
	const h = await createHarness();
	harnesses.push(h);

	// When a prompt that carries a tool barrier is started and its caller's "started" callback throws.
	const failed = await h.session
		.prompt("Request", {
			toolBarrier: { id: "turn-2", deadlineMs: 60_000 },
			promptDisposition: (disposition) => {
				if (disposition === "started") throw new Error("client went away");
			},
		})
		.then(
			() => undefined,
			(error: unknown) => error,
		);

	// Then the throw surfaces and the barrier it armed is not left held until its deadline.
	expect(String(failed)).toContain("client went away");
	expect(h.session.releaseToolBarrier("turn-2")).toBe(false);
});
