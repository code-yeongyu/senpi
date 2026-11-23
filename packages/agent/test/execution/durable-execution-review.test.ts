// senpi#5867 review of #6032: a re-dispatched call of the same turn is answered once, wherever its brain now runs; a
// result is acknowledged only after the loop accepted it; a provider's repeated call id names two calls, not one; a
// duplicate hook call keeps the first caller's answer.
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createLoopHookHost, loopHookCallKey } from "../../src/execution/loop-hook-host.ts";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import type { CommitMatch } from "../../src/execution/testing/epoch-harness.ts";
import { openEpochRig } from "../../src/execution/testing/epoch-harness.ts";
import { encodeRemoteMessage } from "../../src/execution/remote-protocol.ts";
import { createRemoteToolHost } from "../../src/execution/remote-tool-host.ts";
import { call, openHandRig } from "../../src/execution/testing/hand-harness.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";
import { handAdapters } from "./hand-adapters.ts";

const texts = (result: {
	readonly messages: readonly { readonly content: readonly { type: string; text?: string }[] }[];
}) => result.messages.map((message) => message.content.map((part) => part.text ?? "").join(""));

/** The hand's commit of a call's result. */
const resultCommit: CommitMatch = (writes) =>
	writes.some(
		(write) =>
			write.op === "append" &&
			typeof write.data === "object" &&
			write.data !== null &&
			!Array.isArray(write.data) &&
			(write.data as { readonly event?: unknown }).event === "result",
	);

describe("durable execution ids, review of #6032 (senpi#5867)", () => {
	it("a successor brain on another link re-dispatching an in-flight call gets its result; the tool runs once", async () => {
		const rig = await openEpochRig(handAdapters("linux"), {
			brains: [
				{ name: "brain-a", epoch: 1 },
				{ name: "brain-b", epoch: 2 },
			],
		});
		rig.setOwner("s", "brain-a");
		const held = rig.hold(resultCommit);
		void rig.execute("brain-a", "s", [call("call_1")], "turn-1");
		await rig.settle(held.reached, "the first owner's call ran and its result is being committed");

		rig.setOwner("s", "brain-b");
		const successor = rig.execute("brain-b", "s", [call("call_1")], "turn-1");
		await rig.advance(500);
		held.release();
		const result = await rig.settle(successor, "the successor got the call's result");

		expect(texts(result)).toEqual(["ran:call_1"]);
		expect(rig.bodies).toEqual(["s:call_1"]);
	});

	it("a provider that repeats one call id in a message gets two calls, each run once", async () => {
		const rig = await openHandRig(handAdapters("linux"), { placement: "cross-machine" });

		const result = await rig.settle(
			rig.execute("scope", [call("dup"), call("dup")], "parallel", "turn-1"),
			"both calls answered",
		);

		expect(texts(result)).toEqual(["ran:dup", "ran:dup"]);
		expect(rig.bodies).toEqual(["scope:dup", "scope:dup"]);
	});

	it("the hand's result is acknowledged only after the session durably recorded the result message", async () => {
		const rig = await openHandRig(handAdapters("linux"), { placement: "cross-machine" });
		let record: () => void = () => {};
		const recording = new Promise<void>((resolve) => {
			record = resolve;
		});
		let asked = false;
		const recorded = () => {
			asked = true;
			return recording;
		};
		await rig.settle(
			rig.execute("scope", [call("call_1")], "parallel", "turn-1", { recorded }),
			"the batch finished",
		);
		expect(asked).toBe(true);
		await rig.advance(500);
		expect((await rig.rows()).map((row) => row.progress.state)).toEqual(["settled"]);

		record();
		await rig.waitFor(
			async () => (await rig.rows()).every((row) => row.progress.state === "acked"),
			"the hand recorded the acknowledgement",
		);
	});

	it("a result the session failed to record is never acknowledged: the hand keeps it", async () => {
		const rig = await openHandRig(handAdapters("linux"), { placement: "cross-machine" });
		const recorded = () => Promise.reject(new Error("transcript_write_failed"));

		await rig.settle(
			rig.execute("scope", [call("call_1")], "parallel", "turn-1", { recorded }),
			"the batch finished",
		);
		await rig.advance(500);

		expect((await rig.rows()).map((row) => row.progress.state)).toEqual(["settled"]);
	});

	it("an outcome no waiter took is not acknowledged, so a later dispatch of the call still gets it", async () => {
		const sent: string[] = [];
		let deliver: FrameHandler = () => {};
		const transport: Transport = {
			send: async (_lane, payload) => void sent.push(new TextDecoder().decode(payload)),
			onFrame: (handler) => {
				deliver = handler;
			},
			inFlight: () => 0,
			close: () => {},
		};
		createRemoteToolHost({ transport, placement: "cross-machine" });
		const settled = {
			kind: "settled",
			executionId: "restored-1",
			result: { content: [{ type: "text", text: "ran" }], details: {}, isError: false },
		} as const;

		await deliver({ lane: "scope", payload: encodeRemoteMessage(settled) });

		expect(sent.filter((frame) => frame.includes('"ack"'))).toEqual([]);
	});
});

function transportPair() {
	const queues: { to: "loop" | "hand"; payload: Uint8Array }[] = [];
	const handlers: { loop?: FrameHandler; hand?: FrameHandler } = {};
	const end = (self: "loop" | "hand", peer: "loop" | "hand"): Transport => ({
		send: async (_lane, payload) => void queues.push({ to: peer, payload }),
		onFrame: (handler) => {
			handlers[self] = handler;
		},
		inFlight: () => 0,
		close: () => {},
	});
	const flush = async (): Promise<void> => {
		for (let turn = 0; turn < 64; turn++) {
			const next = queues.shift();
			if (next !== undefined) void handlers[next.to]?.({ lane: "hooks", payload: next.payload });
			await Promise.resolve();
		}
	};
	return { loop: end("loop", "hand"), hand: end("hand", "loop"), flush };
}

describe("duplicate loop-hook calls, review of #6032 (senpi#5867)", () => {
	it("a second caller with the same durable key joins the first: both get the answer and the hooks run once", async () => {
		const link = transportPair();
		const runs: string[] = [];
		let finish: (result: JsonValue) => void = () => {};
		serveLoopHooks({
			transport: link.hand,
			lane: "hooks",
			run: (event) => {
				runs.push(event);
				return new Promise<JsonValue>((resolve) => {
					finish = resolve;
				});
			},
		});
		const host = createLoopHookHost({ transport: link.loop, lane: "hooks" });
		const key = loopHookCallKey("session-a", "turn-1", "before_agent_start", 0);
		const first = host.run("before_agent_start", {}, undefined, key);
		await link.flush();
		const second = host.run("before_agent_start", {}, undefined, key);
		await link.flush();
		finish({ ran: 1 });
		await link.flush();

		expect(await Promise.all([first, second])).toEqual([{ ran: 1 }, { ran: 1 }]);
		expect(runs).toEqual(["before_agent_start"]);
	});
});
