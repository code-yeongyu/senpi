// senpi#3566 todo 7: the server's own host-call admission, driven the way a misbehaving child would - 265 calls sent at
// once without the child's admission in front of them.
import { describe, expect, it } from "vitest";
import type { ToolChildChannel } from "./channel.ts";
import { ServerHostCalls } from "./host-calls-server.ts";
import type { ToolChildMessage } from "./protocol.ts";

function recordingChannel() {
	const sent: ToolChildMessage[] = [];
	const channel: Pick<ToolChildChannel, "send"> = {
		send: (frame) => {
			sent.push(frame);
			return true;
		},
	};
	return { channel, sent };
}

describe("ServerHostCalls admission", () => {
	it("runs 8, queues 256, refuses the 265th by its callId, then answers all 264 in order", async () => {
		const { channel, sent } = recordingChannel();
		const held: Array<() => void> = [];
		const calls = new ServerHostCalls(
			channel,
			() => new Promise((resolveCall) => held.push(() => resolveCall("ok"))),
		);
		for (let index = 1; index <= 265; index++)
			calls.handle({
				type: "host_call",
				callId: `c${index}`,
				jobId: "j1",
				kind: "tool",
				name: "count",
				args: { index },
			});
		expect({ ...calls.load("j1"), running: held.length }).toEqual({
			active: 8,
			waiting: 256,
			running: 8,
		});
		expect(sent).toEqual([{ type: "host_call_refused", callId: "c265", code: "host_call_capacity" }]);
		while (held.length > 0) {
			for (const release of held.splice(0)) release();
			await new Promise((resolveTurn) => setImmediate(resolveTurn));
		}
		const replies = sent.filter((frame) => frame.type === "host_reply");
		expect(replies.map((frame) => frame.callId)).toEqual(
			Array.from({ length: 264 }, (_unused, index) => `c${index + 1}`),
		);
		expect(calls.load("j1")).toEqual({ active: 0, waiting: 0 });
	});

	it("answers a queued call of an ended job with an error, never running it", async () => {
		const { channel, sent } = recordingChannel();
		const held: Array<() => void> = [];
		let ran = 0;
		const calls = new ServerHostCalls(channel, () => {
			ran += 1;
			return new Promise((resolveCall) => held.push(() => resolveCall("ok")));
		});
		for (let index = 1; index <= 9; index++)
			calls.handle({ type: "host_call", callId: `c${index}`, jobId: "j1", kind: "tool", name: "t", args: null });
		calls.endJob("j1");
		for (const release of held.splice(0)) release();
		await new Promise((resolveTurn) => setImmediate(resolveTurn));
		await new Promise((resolveTurn) => setImmediate(resolveTurn));
		expect(ran).toBe(8);
		expect(sent.find((frame) => frame.type === "host_reply" && frame.callId === "c9")).toMatchObject({
			error: expect.stringContaining("job ended"),
		});
	});

	it("holds each job to its own capacity: a full job never delays another job's call", () => {
		const { channel, sent } = recordingChannel();
		const running: string[] = [];
		const calls = new ServerHostCalls(channel, (request) => {
			running.push(request.callId);
			return new Promise(() => {});
		});
		for (let index = 1; index <= 264; index++)
			calls.handle({ type: "host_call", callId: `a${index}`, jobId: "j1", kind: "tool", name: "t", args: null });
		calls.handle({ type: "host_call", callId: "b1", jobId: "j2", kind: "tool", name: "t", args: null });
		expect(calls.load("j1")).toEqual({ active: 8, waiting: 256 });
		expect(calls.load("j2")).toEqual({ active: 1, waiting: 0 });
		expect(running).toContain("b1");
		expect(sent).toEqual([]);
	});
});
