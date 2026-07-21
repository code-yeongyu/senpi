import { expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Tool } from "../../src/types.ts";
import { AssistantMessageEventStream as EventStream } from "../../src/utils/event-stream.ts";
import { collectEventSnapshots } from "./invoke-recovery-metadata-fixtures.ts";
import { createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

export const completeInvoke = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
export const danglingInvoke = '<invoke name="Bash"><parameter name="command">echo partial';

type ExtendedUsage = AssistantMessage["usage"] & {
	cacheWrite5m?: number;
	cost: AssistantMessage["usage"]["cost"] & { cacheWrite1h?: number; cacheWrite5m?: number; reasoning?: number };
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return createAssistantMessage(content, stopReason);
}

function usage(marker: number): ExtendedUsage {
	return {
		input: marker,
		output: 0,
		cacheRead: 7,
		cacheWrite: 11,
		cacheWrite1h: 0,
		cacheWrite5m: undefined,
		reasoning: 0,
		totalTokens: marker + 18,
		cost: {
			input: marker / 100,
			output: 0,
			cacheRead: 0.07,
			cacheWrite: 0.11,
			cacheWrite1h: 0,
			cacheWrite5m: undefined,
			reasoning: 0,
			total: marker / 100 + 0.18,
		},
	};
}

export function source(xml = "", marker = 1): AssistantMessage & { fixtureMetadata: { marker: number } } {
	const result = message(xml ? [{ type: "text", text: xml }] : [], "stop") as AssistantMessage & {
		fixtureMetadata: { marker: number };
	};
	result.responseModel = `routed-${marker}`;
	result.responseId = `response-${marker}`;
	result.usage = usage(marker);
	result.fixtureMetadata = { marker };
	return result;
}

export function pushText(inner: EventStream, xml: string, includeTextEnd: boolean): AssistantMessage {
	const started = source("", 1);
	inner.push({ type: "start", partial: started });
	const textStarted = source("", 2);
	textStarted.content.push({ type: "text", text: "" });
	inner.push({ type: "text_start", contentIndex: 0, partial: textStarted });
	const delta = source(xml, 3);
	inner.push({ type: "text_delta", contentIndex: 0, delta: xml, partial: delta });
	if (includeTextEnd) {
		const ended = source(xml, 4);
		inner.push({ type: "text_end", contentIndex: 0, content: xml, partial: ended });
	}
	return delta;
}

export function terminalEvents(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
	return events.filter((event) => event.type === "done" || event.type === "error");
}

export async function collect(stream: AssistantMessageEventStream) {
	const events = await collectEventSnapshots(stream);
	return { events, result: await stream.result() };
}

export function registerInvokeRecoveryTerminationCases(tool: Tool): void {
	it("preserves complete recovery on non-abort transport error", async () => {
		const inner = new EventStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		pushText(inner, completeInvoke, true);
		const transport = source(completeInvoke, 5);
		transport.stopReason = "error";
		transport.errorMessage = "safe transport summary";
		inner.push({ type: "error", reason: "error", error: transport });
		const { events, result } = await collect(wrapped);

		expect(terminalEvents(events)).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
		expect(result).toMatchObject({ stopReason: "toolUse", errorMessage: "safe transport summary" });
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", arguments: { command: "echo recovered" } }),
		);
		expect(JSON.stringify(result.diagnostics)).not.toContain("safe transport summary");
	});

	it("keeps full usage and message metadata byte-identical", async () => {
		const inner = new EventStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		pushText(inner, completeInvoke, true);
		const done = source(completeInvoke, 5);
		inner.push({ type: "done", reason: "stop", message: done });
		const { events } = await collect(wrapped);
		const expectedMarkers = [1, 2, 3, 3, 3, 5];
		expect(JSON.stringify(events)).not.toContain("partialJson");

		expect(
			events.map((event) =>
				JSON.parse(
					JSON.stringify(
						("partial" in event ? event.partial : event.type === "done" ? event.message : event.error).usage,
					),
				),
			),
		).toEqual(expectedMarkers.map((marker) => JSON.parse(JSON.stringify(usage(marker)))));
		for (const [index, event] of events.entries()) {
			const eventMessage = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
			expect(Object.keys(eventMessage.usage)).toEqual(Object.keys(usage(expectedMarkers[index]!)));
			expect(eventMessage).toMatchObject({
				responseModel: `routed-${expectedMarkers[index]}`,
				responseId: `response-${expectedMarkers[index]}`,
				fixtureMetadata: { marker: expectedMarkers[index] },
			});
		}
	});

	it("finalizes a dangling call incomplete on iterator failure", async () => {
		const inner = new EventStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		pushText(inner, danglingInvoke, false);
		inner.fail(new Error("iterator failed"));
		const { events, result } = await collect(wrapped);
		expect(terminalEvents(events)).toHaveLength(1);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "recovered-antml-0",
				name: "Bash",
				arguments: {},
				incomplete: true,
				errorMessage: "Tool call stream ended before completion",
			},
		]);
		expect(result.content[0]).not.toHaveProperty("partialJson");
	});

	async function expectInterruptedAbort(xml: string, includeTextEnd: boolean): Promise<void> {
		const inner = new EventStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		pushText(inner, xml, includeTextEnd);
		const aborted = source(xml, 5);
		aborted.stopReason = "aborted";
		aborted.errorMessage = "Request was aborted";
		inner.push({ type: "error", reason: "aborted", error: aborted });
		const { events, result } = await collect(wrapped);
		expect(terminalEvents(events)).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
		expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
		expect(result.content.filter((block) => block.type === "toolCall")).toEqual([]);
	}

	it("preserves abort after recovered start as interrupted with zero execution", async () => {
		await expectInterruptedAbort(danglingInvoke, false);
	});

	it("preserves abort after complete recovery as interrupted with zero execution", async () => {
		await expectInterruptedAbort(completeInvoke, true);
	});

	it("passes abort before recovery through as interrupted", async () => {
		const inner = new EventStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		const aborted = source("", 1);
		aborted.stopReason = "aborted";
		aborted.errorMessage = "Request was aborted";
		inner.push({ type: "error", reason: "aborted", error: aborted });
		const { events, result } = await collect(wrapped);
		expect(events).toEqual([{ type: "error", reason: "aborted", error: aborted }]);
		expect(result).toEqual(aborted);
	});

	it("passes no-tool transport errors through", async () => {
		const inner = new EventStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		pushText(inner, "ordinary text", true);
		const failure = source("ordinary text", 5);
		failure.stopReason = "error";
		failure.errorMessage = "transport failed";
		inner.push({ type: "error", reason: "error", error: failure });
		const { events, result } = await collect(wrapped);
		expect(terminalEvents(events)).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "transport failed",
			content: [{ type: "text", text: "ordinary text" }],
		});
	});
}
