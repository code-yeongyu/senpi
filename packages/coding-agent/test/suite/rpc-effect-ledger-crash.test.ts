import { describe, expect, it } from "vitest";
import { effectHostWorld, effectOf, openSession, type RawClient, settledTurn } from "./rpc-effect-host-support.ts";

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };
const switchTo = (client: RawClient, sessionId: string, modelId: string, effectId: string) =>
	client.request({ type: "set_model", sessionId, provider: "fauxeffect", modelId, effectId });

// Each case SIGKILLs a real host at a named ledger write (`SENPI_TEST_RPC_EFFECT_CRASH`), then a fresh
// host process reopens the transcript the dead one left behind.
describe("RPC effect ledger crash points", () => {
	it("fails a model switch the host died before applying, and never applies it from the receipt", async () => {
		await using world = await effectHostWorld();
		// Given: the switch was recorded accepted, then the host died before switching.
		const doomed = await world.start({ crashAt: "after:set_model:accepted" });
		const client = await doomed.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		await settledTurn(client, opened.sessionId);
		client.send({
			type: "set_model",
			sessionId: opened.sessionId,
			provider: "fauxeffect",
			modelId: "faux-2",
			effectId: "x1",
		});
		expect((await doomed.exited).signal).toBe("SIGKILL");

		// When
		const host = await world.start();
		const reader = await host.connect();
		const reopened = await openSession(reader, { sessionPath: opened.sessionPath });
		const status = await reader.request({ type: "get_effect_status", sessionId: reopened.sessionId, effectId: "x1" });
		const state = await reader.request({ type: "get_state", sessionId: reopened.sessionId });
		const sameId = await switchTo(reader, reopened.sessionId, "faux-2", "x1");
		const newId = await switchTo(reader, reopened.sessionId, "faux-2", "x2");

		// Then
		expect(effectOf(status)).toMatchObject({
			state: "failed",
			outcome: { reason: "interrupted_by_reopen", action: expect.stringContaining("new effectId") },
		});
		expect(state.data?.model).toMatchObject({ id: "faux-1" });
		expect(sameId).toMatchObject({ success: true, data: { replayed: true, state: "failed" } });
		expect(newId).toMatchObject({ success: true, data: { id: "faux-2", state: "done" } });
		await host.stop();
	}, 240_000);

	it("seals a switch done when model_change carries its id but the done receipt was never written", async () => {
		await using world = await effectHostWorld();
		// Given: the switch landed in the transcript, then the host died before recording done.
		const doomed = await world.start({ crashAt: "before:set_model:done" });
		const client = await doomed.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		await settledTurn(client, opened.sessionId);
		client.send({
			type: "set_model",
			sessionId: opened.sessionId,
			provider: "fauxeffect",
			modelId: "faux-2",
			effectId: "y1",
		});
		expect((await doomed.exited).signal).toBe("SIGKILL");

		// When
		const host = await world.start();
		const reader = await host.connect();
		const reopened = await openSession(reader, { sessionPath: opened.sessionPath });
		const status = await reader.request({ type: "get_effect_status", sessionId: reopened.sessionId, effectId: "y1" });
		const state = await reader.request({ type: "get_state", sessionId: reopened.sessionId });
		const retry = await switchTo(reader, reopened.sessionId, "faux-2", "y1");
		await host.stop();

		// Then
		expect(effectOf(status)).toMatchObject({ state: "done" });
		expect(state.data?.model).toMatchObject({ id: "faux-2" });
		expect(retry).toMatchObject({ success: true, data: { replayed: true, state: "done" } });
		const switches = (await world.readEntries(opened.sessionPath)).filter(
			(entry) => entry.type === "model_change" && entry.effectId === "y1",
		);
		expect(switches).toHaveLength(1);
	}, 240_000);

	it("closes an abort the host died before dispatching as done with no active turn", async () => {
		await using world = await effectHostWorld();
		// Given: a running turn, an abort recorded accepted, then the host died before dispatching it.
		const doomed = await world.start({ crashAt: "after:abort:accepted" });
		const client = await doomed.connect();
		const opened = await openSession(client, { cwd: world.cwd, ...MODEL });
		const started = client.wait((record) => record.type === "agent_start" && record.sessionId === opened.sessionId);
		await client.request({ type: "prompt", sessionId: opened.sessionId, message: "run" });
		await started;
		client.send({ type: "abort", sessionId: opened.sessionId, effectId: "z1" });
		expect((await doomed.exited).signal).toBe("SIGKILL");

		// When
		const host = await world.start();
		const reader = await host.connect();
		const reopened = await openSession(reader, { sessionPath: opened.sessionPath });
		const status = await reader.request({ type: "get_effect_status", sessionId: reopened.sessionId, effectId: "z1" });
		await host.stop();

		// Then
		expect(effectOf(status)).toMatchObject({
			kind: "abort",
			state: "done",
			disposition: "no_active_turn",
			outcome: { kind: "interrupted_by_reopen" },
		});
	}, 240_000);
});
