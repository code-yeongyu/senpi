import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession, type RawClient } from "./rpc-effect-host-support.ts";

// senpi#1971: dequeue_message / edit_queued_message over a real host, as ledger effects.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

type Ordered = { queuedId: string; text: string; mode: string };

async function queued(client: RawClient, sessionId: string): Promise<Ordered[]> {
	const state = await client.request({ type: "get_state", sessionId });
	return (state.data?.ordered as Ordered[] | undefined) ?? [];
}

describe("RPC queued-input dequeue and edit", () => {
	it("removes and edits queued inputs by queuedId, with receipts, and refuses unknown ids with an action", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		await client.request({ type: "prompt", sessionId, message: "hold" });
		await started;
		await client.request({ type: "steer", sessionId, message: "drop me" });
		await client.request({ type: "steer", sessionId, message: "keep me" });
		const [drop, keep] = await queued(client, sessionId);
		expect(drop?.queuedId).toMatch(/^q_\d+$/);

		const removed = await client.request({
			type: "dequeue_message",
			sessionId,
			queuedId: drop?.queuedId,
			effectId: "d1",
		});
		const edited = await client.request({
			type: "edit_queued_message",
			sessionId,
			queuedId: keep?.queuedId,
			text: "kept and edited",
			effectId: "e1",
		});
		const missing = await client.request({ type: "dequeue_message", sessionId, queuedId: "q_999" });
		const invalid = await client.request({ type: "dequeue_message", sessionId, queuedId: "" });

		expect(removed).toMatchObject({ success: true, data: { status: "removed", effectId: "d1", state: "done" } });
		expect(edited).toMatchObject({ success: true, data: { status: "edited", effectId: "e1", state: "done" } });
		expect(missing).toMatchObject({ success: true, data: { status: "not_found", reason: "not_found" } });
		expect(String(missing.data?.action)).toMatch(/get_state|queue_update/);
		expect(invalid).toMatchObject({ success: false });
		const state = await client.request({ type: "get_state", sessionId });
		expect(state.data?.steering).toEqual(["kept and edited"]);
		expect(((state.data?.ordered ?? []) as Ordered[]).map((input) => input.queuedId)).toEqual([keep?.queuedId]);
		const replay = await client.request({
			type: "dequeue_message",
			sessionId,
			queuedId: drop?.queuedId,
			effectId: "d1",
		});
		expect(replay).toMatchObject({ success: true, data: { status: "removed", replayed: true } });
		await host.stop();
	}, 240_000);
});
