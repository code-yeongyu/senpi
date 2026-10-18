import { describe, expect, it } from "vitest";
import { effectHostWorld, openSession, type RawClient } from "./rpc-effect-host-support.ts";

// senpi#3156 (F10b): abort awaits quiesce, clears the queue, and names who aborted, on a real host.

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };

async function streaming(client: RawClient, sessionId: string): Promise<void> {
	const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
	await client.request({ type: "prompt", sessionId, message: "run until aborted" });
	await started;
}

describe("RPC abort quiesce", () => {
	it("answers awaitIdle only after the turn is idle, and every attached client sees who aborted", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const owner = await host.connect();
		const aborter = await host.connect();
		const { sessionId, sessionPath } = await openSession(owner, { cwd: world.cwd, ...MODEL });
		await openSession(aborter, { sessionPath });
		await streaming(owner, sessionId);
		const ownerEnd = owner.wait((record) => record.type === "agent_end" && record.sessionId === sessionId);

		const answer = await aborter.request({ type: "abort", sessionId, effectId: "a1", awaitIdle: true });

		expect(answer).toMatchObject({ success: true, data: { effectId: "a1", stopped: true, idle: true, cleared: 0 } });
		expect(aborter.records.some((record) => record.type === "agent_idle" && record.sessionId === sessionId)).toBe(
			true,
		);
		const ended = await ownerEnd;
		expect(ended.abortedBy).toMatchObject({ effectId: "a1", connectionId: expect.any(String) });
		const aborterEnd = aborter.records.find(
			(record) => record.type === "agent_end" && record.sessionId === sessionId,
		);
		expect(aborterEnd?.abortedBy).toEqual(ended.abortedBy);
		const status = await aborter.request({ type: "get_effect_status", sessionId, effectId: "a1" });
		expect(status.data?.effect).toMatchObject({ state: "done" });
		await host.stop();
	}, 240_000);

	it("reports stopped false when the turn outlives graceMs, and the abort still finishes later", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, {
			cwd: world.cwd,
			provider: "fauxeffect",
			modelId: "faux-stubborn",
		});
		await streaming(client, sessionId);

		const answer = await client.request({ type: "abort", sessionId, effectId: "a2", awaitIdle: true, graceMs: 300 });

		expect(answer).toMatchObject({ success: true, data: { effectId: "a2", stopped: false, idle: false } });
		const pending = await client.request({ type: "get_effect_status", sessionId, effectId: "a2" });
		expect(pending.data?.effect).toMatchObject({ state: "applied" });
		const idle = client.wait((record) => record.type === "agent_idle" && record.sessionId === sessionId);
		await world.release();
		await idle;
		const done = await client.request({ type: "get_effect_status", sessionId, effectId: "a2" });
		expect(done.data?.effect).toMatchObject({ state: "done" });
		await host.stop();
	}, 240_000);

	it("clearQueue drains queued input with a cleared receipt and a queue_update", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });
		await streaming(client, sessionId);
		const steered = await client.request({ type: "steer", sessionId, message: "later", clientMessageId: "q1" });
		expect(steered.success).toBe(true);
		const emptied = client.wait(
			(record) =>
				record.type === "queue_update" &&
				record.sessionId === sessionId &&
				Array.isArray(record.steering) &&
				record.steering.length === 0,
		);

		const answer = await client.request({ type: "abort", sessionId, clearQueue: true, awaitIdle: true });

		expect(answer).toMatchObject({ success: true, data: { stopped: true, cleared: 1 } });
		await emptied;
		const state = await client.request({ type: "get_state", sessionId });
		expect(state.data?.pendingMessageCount ?? 0).toBe(0);
		const receipt = await client.request({ type: "get_effect_status", sessionId, effectId: "q1" });
		expect(receipt.data?.effect).toMatchObject({
			state: "failed",
			outcome: { kind: "cleared", action: expect.any(String) },
		});
		await host.stop();
	}, 240_000);

	it("refuses graceMs above the maximum with a reason and an action, and keeps plain abort unchanged", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });

		const refused = await client.request({ type: "abort", sessionId, awaitIdle: true, graceMs: 70_000 });
		const plain = await client.request({ type: "abort", sessionId });

		expect(refused).toMatchObject({ success: false, errorCode: "invalid_argument" });
		expect(refused.errorData).toMatchObject({ reason: "invalid_grace_ms", action: expect.stringMatching(/60000/) });
		expect(plain).toMatchObject({ success: true, command: "abort" });
		expect(plain.data).toBeUndefined();
		await host.stop();
	}, 240_000);

	it("does not name an old client's idle abort on a later system abort", async () => {
		await using world = await effectHostWorld();
		const host = await world.start();
		const client = await host.connect();
		const { sessionId } = await openSession(client, { cwd: world.cwd, ...MODEL });
		const idleAbort = await client.request({ type: "abort", sessionId, effectId: "idle-abort" });
		expect(idleAbort).toMatchObject({ success: true, data: { state: "done" } });
		await streaming(client, sessionId);
		const ended = client.wait((record) => record.type === "agent_end" && record.sessionId === sessionId);

		await client.request({ type: "prompt", sessionId, message: "/sysabort" });

		const end = await ended;
		expect(end).toMatchObject({ aborted: true, abortSource: "system" });
		expect(end.abortedBy).toBeUndefined();
		await host.stop();
	}, 240_000);
});
