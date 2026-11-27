// senpi#7098 follow-up (review of #7105, MEDIUM-1). When the route to a predecessor breaks (a socket error, an
// oversized line), the successor retries the local reopen while the predecessor's claim still stands, which can last
// for the rest of its running turn. A command sent on the routed handle meanwhile waited for that switch without a
// bound, and a recovery that stopped (this host began draining) never told it. Every waiter now answers: at most the
// close grace window later with a retryable refusal, or as soon as the recovery ends with why it ended.
import { afterEach, expect, it, vi } from "vitest";
import { SWITCH_PENDING } from "../../../src/modes/rpc/predecessor-switch.ts";
import {
	advanceUntil,
	answer,
	type Cleanups,
	fakePredecessor,
	successorWithPredecessorClaim,
} from "../rpc-predecessor-route-support.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CLOSE_GRACE_MS = 60_000;
const RETRY_STEP_MS = 250;

/** A client attached to `held.jsonl` through the route while the predecessor's claim stands; `breakRoute` drops it. */
async function routedSession() {
	const host = await successorWithPredecessorClaim(cleanups, { closeGraceMs: CLOSE_GRACE_MS });
	await host.predecessorHolds();
	const predecessor = await fakePredecessor(cleanups, host, {
		list_sessions: (stream, request) => answer(stream, request, { sessions: [] }),
		open_session: (stream, request) => answer(stream, request, { sessionId: "upstream-1" }),
	});
	const opened = await host.send({ type: "open_session", id: "routed", sessionPath: host.heldPath });
	expect(opened, JSON.stringify(opened)).toMatchObject({ success: true });
	const sessionId = (opened as { data: { sessionId: string } }).data.sessionId;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	return { host, sessionId, breakRoute: predecessor.kill };
}

it.skipIf(process.platform === "win32")(
	"a command waiting for the switch answers a retryable refusal once the close grace window passes",
	async () => {
		const { host, sessionId, breakRoute } = await routedSession();
		breakRoute();

		const reply = host.send({ type: "get_state", id: "waiting", sessionId });

		expect(await advanceUntil(reply, CLOSE_GRACE_MS), "the routed command never answered").toBe(true);
		expect(await reply).toMatchObject({ success: false, error: SWITCH_PENDING });
	},
);

it.skipIf(process.platform === "win32")(
	"a recovery that stops because this host drains answers every waiting command",
	async () => {
		const { host, sessionId, breakRoute } = await routedSession();
		await host.router.beginDrain();
		breakRoute();

		const reply = host.send({ type: "get_state", id: "waiting", sessionId });

		expect(
			await advanceUntil(reply, RETRY_STEP_MS, 40),
			"the waiting command was left behind by the stopped recovery",
		).toBe(true);
		expect(await reply).toMatchObject({ success: false, error: "host_draining" });
	},
);
