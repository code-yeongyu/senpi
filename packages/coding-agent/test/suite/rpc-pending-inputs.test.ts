import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession } from "./rpc-effect-host-support.ts";

// senpi#3549: get_pending_inputs and pending_input_update over a real host.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

describe("RPC pending inputs", () => {
	it("reads queued input with explicit outcomes and publishes each change with a rising cursor", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		await client.request({ type: "prompt", sessionId, message: "hold" });
		await started;
		const admitted = client.wait(
			(record) =>
				record.type === "pending_input_update" &&
				record.sessionId === sessionId &&
				JSON.stringify(record.changes).includes('"state":"queued"'),
		);

		await client.request({ type: "follow_up", sessionId, message: "draft", clientMessageId: "c-1" });
		const update = await admitted;
		const queued = (await client.request({ type: "get_state", sessionId })).data?.ordered as { queuedId: string }[];
		const edited = client.wait(
			(record) =>
				record.type === "pending_input_update" &&
				record.sessionId === sessionId &&
				JSON.stringify(record.changes).includes('"state":"edited"'),
		);
		await client.request({
			type: "edit_queued_message",
			sessionId,
			queuedId: queued[0]?.queuedId,
			text: "final",
			expectedRevision: 1,
		});
		const editUpdate = await edited;
		const snapshot = await client.request({
			type: "get_pending_inputs",
			sessionId,
			knownClientMessageIds: ["c-1", "never-sent"],
		});

		expect(update).toMatchObject({ changes: [{ clientMessageId: "c-1", state: "queued", text: "draft" }] });
		expect(Number(editUpdate.cursor)).toBeGreaterThan(Number(update.cursor));
		expect(snapshot).toMatchObject({
			success: true,
			data: {
				throughCursor: editUpdate.cursor,
				inputs: [{ clientMessageId: "c-1", state: "edited", text: "final", revision: 2 }],
				outcomes: [
					{ clientMessageId: "c-1", status: "admitted", projection: { state: "edited" } },
					{ clientMessageId: "never-sent", status: "not_admitted" },
				],
			},
		});
		await host.stop();
	}, 240_000);

	it("refuses more than 64 known ids before reading anything", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });

		const refused = await client.request({
			type: "get_pending_inputs",
			sessionId,
			knownClientMessageIds: Array.from({ length: 65 }, (_, index) => `c-${index}`),
		});

		expect(refused).toMatchObject({ success: false });
		expect(String(refused.error)).toMatch(/at most 64/);
		await host.stop();
	}, 240_000);
});
