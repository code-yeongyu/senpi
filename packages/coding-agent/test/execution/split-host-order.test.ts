// S32 (senpi#5641): a split session's ToolHost keeps the fused pipeline's batch semantics across the two sides:
// source order of results and their message events, a sequential tool's barrier inside a parallel batch, and no new
// work once the run is aborted.
import { type AgentEvent, createSplitToolHost, type ToolHost } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { call, recordingHost, resultOf, texts } from "./session-plane-fixture.ts";

describe("split host batch order (S32)", () => {
	it("runs a sequential mixed batch side by side in source order, a repeated call ID included", async () => {
		const ran: string[] = [];
		const host = createSplitToolHost({
			loopSide: (name) => name === "todo",
			isSequential: () => false,
			loop: recordingHost("loop", ran),
			hand: recordingHost("hand", ran),
		});
		const calls = [call("a", "read"), call("dup", "todo"), call("dup", "bash"), call("d", "todo")];

		const { messages, terminate } = await host.execute(
			{ scope: { id: "s32", root: "/work" }, calls, mode: "sequential" },
			{ emit: () => {} },
		);

		expect(ran).toEqual(["hand:read", "loop:todo", "hand:bash", "loop:todo"]);
		expect(texts(messages)).toEqual(["hand:read", "loop:todo", "hand:bash", "loop:todo"]);
		expect(terminate).toBe(false);
	});

	it("emits a parallel mixed batch's result messages in source order, however the sides finish", async () => {
		let loopFinished: () => void = () => {};
		const loopDone = new Promise<void>((resolve) => {
			loopFinished = resolve;
		});
		const emittingHost = (before: () => Promise<void>, after: () => void): ToolHost => ({
			async execute(batch, { emit }) {
				await before();
				const messages = batch.calls.map((raw) => resultOf(raw, raw.name));
				for (const message of messages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
				}
				after();
				return { messages, terminate: false };
			},
		});
		const host = createSplitToolHost({
			loopSide: (name) => name === "todo",
			isSequential: () => false,
			loop: emittingHost(async () => {}, loopFinished),
			hand: emittingHost(
				() => loopDone,
				() => {},
			),
		});
		const ended: string[] = [];

		const { messages } = await host.execute(
			{ scope: { id: "s32", root: "/work" }, calls: [call("a", "read"), call("b", "todo")], mode: "parallel" },
			{
				emit: (event: AgentEvent) => {
					if (event.type === "message_end" && event.message.role === "toolResult")
						ended.push(event.message.toolCallId);
				},
			},
		);

		expect(ended).toEqual(["a", "b"]);
		expect(messages.map((message) => message.toolCallId)).toEqual(["a", "b"]);
	});

	it("runs a sequential tool in a parallel batch after every earlier call and before every later one", async () => {
		const log: string[] = [];
		const steppingHost = (side: string): ToolHost => ({
			async execute(batch) {
				for (const raw of batch.calls) log.push(`${side}:${raw.name}:start`);
				await Promise.resolve();
				for (const raw of batch.calls) log.push(`${side}:${raw.name}:end`);
				return { messages: batch.calls.map((raw) => resultOf(raw, raw.name)), terminate: false };
			},
		});
		const host = createSplitToolHost({
			loopSide: (name) => name === "todo",
			isSequential: (name) => name === "todo",
			loop: steppingHost("loop"),
			hand: steppingHost("hand"),
		});

		const { messages } = await host.execute(
			{
				scope: { id: "s32", root: "/work" },
				calls: [call("a", "bash"), call("b", "todo"), call("c", "read")],
				mode: "parallel",
			},
			{ emit: () => {} },
		);

		expect(log).toEqual([
			"hand:bash:start",
			"hand:bash:end",
			"loop:todo:start",
			"loop:todo:end",
			"hand:read:start",
			"hand:read:end",
		]);
		expect(texts(messages)).toEqual(["bash", "todo", "read"]);
	});

	it("starts no later segment of a sequential batch once the run is aborted", async () => {
		const controller = new AbortController();
		const ran: string[] = [];
		const aborting: ToolHost = {
			async execute(batch) {
				ran.push(...batch.calls.map((raw) => `hand:${raw.name}`));
				controller.abort();
				return { messages: batch.calls.map((raw) => resultOf(raw, "aborted")), terminate: false };
			},
		};
		const host = createSplitToolHost({
			loopSide: (name) => name === "todo",
			isSequential: () => false,
			loop: recordingHost("loop", ran),
			hand: aborting,
		});

		const { messages } = await host.execute(
			{
				scope: { id: "s32", root: "/work" },
				calls: [call("a", "read"), call("b", "todo"), call("c", "bash")],
				mode: "sequential",
			},
			{ emit: () => {}, signal: controller.signal },
		);

		expect(ran).toEqual(["hand:read"]);
		expect(texts(messages)).toEqual(["aborted"]);
	});
});
