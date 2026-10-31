import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession, type RawClient } from "./rpc-effect-host-support.ts";

// senpi#3224: steer / follow_up { whenIdle: "start" } start a turn on an idle session through the prompt path.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

const startsOf = (client: RawClient, sessionId: string) =>
	client.records.filter((record) => record.type === "agent_start" && record.sessionId === sessionId).length;

describe("RPC steer/follow_up whenIdle", () => {
	it("starts a turn on an idle session, queues into a running one, and leaves the default unchanged", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const info = await client.request({ type: "get_protocol_info" });
		expect(info.data?.capabilities).toContain("steer_when_idle");
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });

		const plain = await client.request({ type: "steer", sessionId, message: "queued only", clientMessageId: "d1" });
		expect(plain.data).toMatchObject({ disposition: "queued" });
		expect(startsOf(client, sessionId)).toBe(0);
		await client.request({ type: "clear_queue", sessionId });

		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
		const steer = await client.request({
			type: "steer",
			sessionId,
			message: "start now",
			clientMessageId: "s1",
			whenIdle: "start",
		});
		expect(steer).toMatchObject({ success: true, data: { disposition: "started", clientMessageId: "s1" } });
		await started;

		const followUp = await client.request({
			type: "follow_up",
			sessionId,
			message: "after this turn",
			clientMessageId: "f1",
			whenIdle: "start",
		});
		const steerInto = await client.request({
			type: "steer",
			sessionId,
			message: "while running",
			clientMessageId: "s2",
			whenIdle: "start",
		});
		expect(followUp.data).toMatchObject({ disposition: "queued" });
		expect(steerInto.data).toMatchObject({ disposition: "queued" });
		expect(startsOf(client, sessionId)).toBe(1);

		const receipt = await client.request({ type: "get_effect_status", sessionId, effectId: "s1" });
		expect(receipt.data?.effect).toMatchObject({ kind: "input", disposition: "started" });
		await host.stop();
	}, 240_000);

	it("refuses an unknown whenIdle with a reason that names the valid values", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });

		const refused = await client.request({ type: "follow_up", sessionId, message: "x", whenIdle: "bogus" });

		expect(refused).toMatchObject({ success: false });
		expect(String(refused.error)).toMatch(/whenIdle must be "queue" or "start"/);
		expect(startsOf(client, sessionId)).toBe(0);
		await host.stop();
	}, 240_000);
});
