import { getAssistantCapture } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import { createInternalAgentChannel } from "../src/index.ts";
import { dispatchInternalAgent, internalLoopSink, internalProgressSink } from "../src/internal-events.ts";
import { attempt } from "./internal-events-recovery-fixture.ts";

function captured(): boolean {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const event = attempt("", "fixture").pushed[0];
	if (!event) throw new Error("fixture has no event");
	stream.push(event);
	return getAssistantCapture(event) !== undefined;
}
// #4349: capability creation alone never enables capture; only the first/last listener owns that resource.
it("holds capture only between the first subscription and last release", () => {
	const channel = createInternalAgentChannel();
	expect(captured()).toBe(false);
	expect(internalLoopSink(channel)).toEqual({});
	expect(dispatchInternalAgent(channel, { event: { type: "agent_start" } })).toBeUndefined();
	const first = channel.subscribe(() => {});
	const second = channel.subscribe(() => {});
	try {
		expect(captured()).toBe(true);
		first();
		expect(captured()).toBe(true);
		second();
		expect(captured()).toBe(false);
		expect(internalLoopSink(channel)).toEqual({});
	} finally {
		first();
		second();
	}
});
it("gives a run started without listeners no progress sink even after a late subscription", () => {
	const channel = createInternalAgentChannel();
	const runConfig = internalLoopSink(channel);
	const release = channel.subscribe(() => {});
	try {
		expect(runConfig[internalProgressSink]).toBeUndefined();
		expect(internalLoopSink(channel)[internalProgressSink]).toBeTypeOf("function");
	} finally {
		release();
	}
});
