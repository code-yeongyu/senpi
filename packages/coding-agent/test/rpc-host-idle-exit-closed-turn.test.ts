/**
 * A session closed mid-turn must not pin its REAL supervisor's idle exit forever. The close seals the
 * session before the aborted turn's `agent_settled` is written, so the host publishes the settle the
 * observer is owed (`reason: "session_closed"`) before it seals - for a worker session too, whose
 * `session_closed` only its attached connections ever see (I4).
 */
import { afterEach, describe, expect, it } from "vitest";
import { HeldAnthropicModel, JsonlPeer, openedSessionId, type WireRecord } from "./helpers/rpc-generation-support.ts";
import { endpointScratch, realHost, sweepEndpointScratches, tracked } from "./helpers/rpc-host-endpoint-scratch.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

const IDLE_EXIT_MS = 1_000;
/** The idle window, then the slack a supervisor needs to stop its host child and exit. */
const EXIT_BOUND_MS = IDLE_EXIT_MS + 2_000;

afterEach(sweepEndpointScratches, 180_000);

async function hostWithHeldTurn(label: string) {
	const held = await HeldAnthropicModel.start();
	tracked.models.push(held);
	const qa = endpointScratch(label, held.origin);
	const supervisor = await realHost(qa, qa.legacy, { idleExitMs: IDLE_EXIT_MS });
	const client = await JsonlPeer.connect(qa.legacy);
	tracked.peers.push(client);
	return { qa, supervisor, client };
}

async function startHeldTurn(client: JsonlPeer, open: WireRecord): Promise<string> {
	const sessionId = openedSessionId(await client.request(open));
	const started = client.waitFor((record) => record.type === "agent_start" && record.sessionId === sessionId);
	await client.request({ id: `prompt-${sessionId}`, type: "prompt", sessionId, message: "hold this turn open" });
	await started;
	return sessionId;
}

describe.skipIf(process.platform === "win32")("idle exit after a session closed mid-turn", () => {
	for (const kind of ["worker", "interactive"] as const) {
		it(`exits within the idle window once a ${kind} session closed mid-turn and every client left`, async () => {
			const { qa, supervisor, client } = await hostWithHeldTurn(kind.slice(0, 3));
			const open = { id: "open", type: "open_session", cwd: qa.cwd, kind, retain_on_disconnect: kind === "worker" };
			const sessionId = await startHeldTurn(client, open);

			await client.request({ id: "close", type: "close_session", sessionId });
			const closedAt = performance.now();
			client.destroy();

			expect(await waitForPidGone(supervisor, EXIT_BOUND_MS)).toBe(true);
			console.info(`${kind}: supervisor exited ${(performance.now() - closedAt).toFixed(0)} ms after the close`);
		}, 120_000);
	}

	it("tells an observing connection the turn settled, and still never shows it a worker's session_closed", async () => {
		const { qa, client } = await hostWithHeldTurn("obs");
		const observer = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(observer);
		const sessionId = await startHeldTurn(client, { id: "open", type: "open_session", cwd: qa.cwd, kind: "worker" });
		const settled = observer.waitFor((record) => record.type === "agent_settled" && record.sessionId === sessionId);

		await client.request({ id: "close", type: "close_session", sessionId });
		expect(await settled).toMatchObject({ reason: "session_closed" });
		// Records ahead of this response on the observer's connection have all been read once it arrives.
		await observer.request({ id: "after", type: "list_sessions" });
		expect(observer.messages.filter((record) => record.type === "session_closed")).toEqual([]);
	}, 120_000);
});
