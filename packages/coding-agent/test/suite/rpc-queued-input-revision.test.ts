import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession, type RawClient } from "./rpc-effect-host-support.ts";

// senpi#3459: expectedRevision on dequeue_message / edit_queued_message over a real host.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

type Ordered = { queuedId: string; text: string; mode: string; revision: number };

async function queued(client: RawClient, sessionId: string): Promise<Ordered[]> {
	const state = await client.request({ type: "get_state", sessionId });
	return (state.data?.ordered as Ordered[] | undefined) ?? [];
}

describe("RPC queued-input expected revision", () => {
	it("refuses a stale revision with the current one, answers edits with their new revision, and replays a conflict", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });
		const info = await client.request({ type: "get_protocol_info" });
		expect(info.data?.capabilities).toContain("queued_message_revision");
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		await client.request({ type: "prompt", sessionId, message: "hold" });
		await started;
		await client.request({ type: "follow_up", sessionId, message: "draft" });
		const [seen] = await queued(client, sessionId);
		expect(seen?.revision).toBe(1);

		const first = await client.request({
			type: "edit_queued_message",
			sessionId,
			queuedId: seen?.queuedId,
			text: "client B",
			expectedRevision: 1,
		});
		const stale = await client.request({
			type: "edit_queued_message",
			sessionId,
			queuedId: seen?.queuedId,
			text: "client A",
			expectedRevision: 1,
			effectId: "e-stale",
		});
		const staleRemove = await client.request({
			type: "dequeue_message",
			sessionId,
			queuedId: seen?.queuedId,
			expectedRevision: 1,
		});
		const replay = await client.request({
			type: "edit_queued_message",
			sessionId,
			queuedId: seen?.queuedId,
			text: "client A",
			expectedRevision: 1,
			effectId: "e-stale",
		});
		const badRevision = await client.request({
			type: "dequeue_message",
			sessionId,
			queuedId: seen?.queuedId,
			expectedRevision: 0,
		});

		expect(first).toMatchObject({
			success: true,
			data: { status: "edited", queuedId: seen?.queuedId, text: "client B", revision: 2 },
		});
		expect(stale).toMatchObject({
			success: true,
			data: {
				status: "conflict",
				queuedId: seen?.queuedId,
				currentRevision: 2,
				reason: "conflict",
				effectId: "e-stale",
				state: "failed",
			},
		});
		expect(String(stale.data?.action)).toMatch(/get_state|queue_update/);
		expect(staleRemove).toMatchObject({ success: true, data: { status: "conflict", currentRevision: 2 } });
		expect(replay).toMatchObject({ success: true, data: { status: "conflict", replayed: true } });
		expect(badRevision).toMatchObject({ success: false });
		expect(await queued(client, sessionId)).toMatchObject([
			{ queuedId: seen?.queuedId, text: "client B", revision: 2 },
		]);
		await host.stop();
	}, 240_000);

	it("answers a same-id retry with exactly the fields of the live answer, for every outcome", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		await client.request({ type: "prompt", sessionId, message: "hold" });
		await started;
		await client.request({ type: "follow_up", sessionId, message: "edit me" });
		await client.request({ type: "follow_up", sessionId, message: "remove me" });
		const [editTarget, removeTarget] = await queued(client, sessionId);
		const requests = [
			{
				type: "edit_queued_message",
				queuedId: editTarget?.queuedId,
				text: "edited",
				expectedRevision: 1,
				effectId: "r-edit",
			},
			{
				type: "edit_queued_message",
				queuedId: editTarget?.queuedId,
				text: "stale",
				expectedRevision: 1,
				effectId: "r-conflict",
			},
			{ type: "dequeue_message", queuedId: removeTarget?.queuedId, effectId: "r-remove" },
			{ type: "dequeue_message", queuedId: "q_999", effectId: "r-missing" },
		];
		for (const request of requests) {
			const live = await client.request({ ...request, sessionId });
			const replay = await client.request({ ...request, sessionId });
			const { replayed, ...replayData } = (replay.data ?? {}) as Record<string, unknown>;
			const { replayed: _live, ...liveData } = (live.data ?? {}) as Record<string, unknown>;
			expect(replayed).toBe(true);
			expect(replayData).toEqual(liveData);
		}
		await host.stop();
	}, 240_000);
});
