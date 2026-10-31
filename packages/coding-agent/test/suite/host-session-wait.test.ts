import { afterEach, describe, expect, it, vi } from "vitest";
import { runHostSessionRequest } from "../../src/modes/rpc/host-session-runner.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { HeldAnthropicModel } from "../helpers/rpc-generation-support.ts";
import { cleanupHostSessionRigs, rig, wireRig } from "./host-session-support.ts";

afterEach(cleanupHostSessionRigs, 120_000);

// #3073: `wait` settles on real host events, never on elapsed time, and reports a lost transport.
describe("host session wait", () => {
	it("waits for a real settled run and answers an already idle session", async () => {
		const { target, ref, fake } = await rig(true);
		await runHostSessionRequest({ action: "prompt", target, ref, text: "unique-600" });
		await runHostSessionRequest({ action: "steer", target, ref, text: "unique-601" });
		const snapshotted = Promise.withResolvers<void>();
		const getState = RpcClient.prototype.getState;
		vi.spyOn(RpcClient.prototype, "getState").mockImplementation(async function (this: RpcClient) {
			const state = await getState.call(this);
			snapshotted.resolve();
			return state;
		});
		const waiting = runHostSessionRequest({ action: "wait", target, ref, until: "done", timeoutMs: 20_000 });
		await snapshotted.promise;
		if (fake instanceof HeldAnthropicModel) fake.release();
		expect(await waiting).toMatchObject({
			exitCode: 0,
			payload: { action: "wait", outcome: "done", state: { isStreaming: false } },
		});
		expect(
			await runHostSessionRequest({ action: "wait", target, ref, until: "idle", timeoutMs: 20_000 }),
		).toMatchObject({ exitCode: 0, payload: { outcome: "already_idle" } });
	}, 120_000);

	it("does not miss settlement delivered before the initial state reply", async () => {
		const idle = { isStreaming: false, steering: [], followUp: [], ordered: [], pendingMessageCount: 0 };
		const wire = await wireRig((call, send, reply) => {
			if (call === 1) send({ type: "agent_settled", sessionId: "rpc-1" });
			reply(idle);
		});
		expect(
			await runHostSessionRequest({
				action: "wait",
				target: wire.target,
				ref: "rpc-1",
				until: "done",
				timeoutMs: 1000,
			}),
		).toMatchObject({ exitCode: 0, payload: { outcome: "done" } });
		expect(wire.stateReads()).toBe(2);
	});

	it("checks queues once per idle event and ignores low-level run and turn endings", async () => {
		const wire = await wireRig((call, send, reply) => {
			reply({
				isStreaming: call === 1,
				steering: call === 2 ? ["queued"] : [],
				followUp: [],
				ordered: [],
				pendingMessageCount: call === 2 ? 1 : 0,
			});
			if (call === 1) {
				send({ type: "turn_end", sessionId: "rpc-1" });
				send({ type: "agent_end", sessionId: "rpc-1" });
				send({ type: "agent_settled", sessionId: "rpc-1" });
			}
			if (call < 3) send({ type: "agent_idle", sessionId: "rpc-1" });
		});
		expect(
			await runHostSessionRequest({
				action: "wait",
				target: wire.target,
				ref: "rpc-1",
				until: "idle",
				timeoutMs: 1000,
			}),
		).toMatchObject({ exitCode: 0, payload: { outcome: "idle" } });
		expect(wire.stateReads()).toBe(3);
	});

	it.each(["session_closed", "session_parked", "synthetic_settle"])(
		"reports terminal %s without reading a dead session",
		async (kind) => {
			const wire = await wireRig((_call, send) => {
				send(
					kind === "synthetic_settle"
						? { type: "agent_settled", sessionId: "rpc-1", reason: "session_closed" }
						: { type: kind, sessionId: "rpc-1", reason: "host_shutdown" },
				);
			});
			expect(
				await runHostSessionRequest({
					action: "wait",
					target: wire.target,
					ref: "rpc-1",
					until: "done",
					timeoutMs: 1000,
				}),
			).toMatchObject({ exitCode: 0, payload: { outcome: kind === "synthetic_settle" ? "session_closed" : kind } });
		},
	);

	it("reports a lost transport instead of waiting for its deadline", async () => {
		const wire = await wireRig((_call, _send, _reply, socket) => socket.destroy());
		expect(
			await runHostSessionRequest({
				action: "wait",
				target: wire.target,
				ref: "rpc-1",
				until: "done",
				timeoutMs: 1000,
			}),
		).toMatchObject({ exitCode: 1, payload: { reason: "transport_gone" } });
	});

	it("times out a held turn and leaves it available to abort", async () => {
		const { target, ref } = await rig(true);
		await runHostSessionRequest({ action: "prompt", target, ref, text: "held timeout" });
		expect(await runHostSessionRequest({ action: "wait", target, ref, until: "done", timeoutMs: 10 })).toMatchObject({
			exitCode: 1,
			payload: { reason: "wait_timeout", timeoutMs: 10 },
		});
		expect(await runHostSessionRequest({ action: "abort", target, ref })).toMatchObject({ exitCode: 0 });
	}, 120_000);
});
