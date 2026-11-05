// senpi#5867: a remote tool call's execution id comes from durable turn state, so a fresh brain that resumes a turn and
// dispatches its pending call again reaches the hand's record of that call instead of running the tool a second time.
import { describe, expect, it } from "vitest";
import { remoteExecutionId } from "../../src/execution/remote-tool-host.ts";
import { call, openHandRig } from "../../src/execution/testing/hand-harness.ts";
import { handAdapters } from "./hand-adapters.ts";

const texts = (result: {
	readonly messages: readonly { readonly content: readonly { type: string; text?: string }[] }[];
}) => result.messages.map((message) => message.content.map((part) => part.text ?? "").join(""));

describe("durable remote execution ids (senpi#5867)", () => {
	it("a fresh brain re-dispatching a pending call of the same turn joins it: the tool runs once", async () => {
		const rig = await openHandRig(handAdapters("linux"), { placement: "cross-machine" });
		rig.gateBodies();
		void rig.execute("scope", [call("call_1")], "parallel", "turn-1");
		await rig.runUntil(() => rig.bodies.length === 1, "the first brain's call is running on the hand");

		rig.replaceSession();
		const resumed = rig.execute("scope", [call("call_1")], "parallel", "turn-1");
		await rig.advance(500);
		rig.release("call_1");
		const result = await rig.settle(resumed, "the fresh brain got the call's result");

		expect(texts(result)).toEqual(["ran:call_1"]);
		expect(rig.bodies).toEqual(["scope:call_1"]);
	});

	it("a fresh brain re-dispatching a call that already settled gets the hand's record: the tool runs once", async () => {
		const rig = await openHandRig(handAdapters("linux"), { placement: "cross-machine" });
		await rig.settle(rig.execute("scope", [call("call_1")], "parallel", "turn-1"), "the first dispatch settled");

		rig.replaceSession();
		const result = await rig.settle(
			rig.execute("scope", [call("call_1")], "parallel", "turn-1"),
			"the fresh brain got an answer",
		);

		expect(rig.bodies).toEqual(["scope:call_1"]);
		expect(texts(result)).not.toEqual([]);
	});

	it("ids differ across sessions, turns and calls, and are stable for the same three", () => {
		const ids = [
			remoteExecutionId({ id: "session-a", root: "/w" }, "turn-1", "call_1"),
			remoteExecutionId({ id: "session-a", root: "/w" }, "turn-1", "call_1"),
			remoteExecutionId({ id: "session-b", root: "/w" }, "turn-1", "call_1"),
			remoteExecutionId({ id: "session-a", root: "/w" }, "turn-2", "call_1"),
			remoteExecutionId({ id: "session-a", root: "/w" }, "turn-1", "call_2"),
		];

		expect(ids[0]).toBe(ids[1]);
		expect(new Set(ids).size).toBe(4);
	});
});
