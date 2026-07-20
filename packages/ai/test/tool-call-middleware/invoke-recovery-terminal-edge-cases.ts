import { expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../../src/types.ts";
import { AssistantMessageEventStream as EventStream } from "../../src/utils/event-stream.ts";
import { nextEvent } from "./invoke-recovery-stream-fixtures.ts";
import {
	collect,
	completeInvoke,
	danglingInvoke,
	pushText,
	source,
	terminalEvents,
} from "./invoke-recovery-termination-cases.ts";

class ExhaustedStream extends EventStream {
	private readonly events: readonly AssistantMessageEvent[];
	private readonly fallback: AssistantMessage;

	constructor(events: readonly AssistantMessageEvent[], fallback: AssistantMessage) {
		super();
		this.events = events;
		this.fallback = fallback;
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		let index = 0;
		return {
			next: async () =>
				index < this.events.length
					? { value: this.events[index++]!, done: false }
					: { value: undefined, done: true },
		};
	}

	override result(): Promise<AssistantMessage> {
		return Promise.resolve(this.fallback);
	}
}

class CancellableStream extends EventStream {
	returnCalls = 0;

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const iterator = super[Symbol.asyncIterator]();
		return {
			next: () => iterator.next(),
			return: async () => {
				this.returnCalls += 1;
				return { value: undefined, done: true };
			},
		};
	}
}

export function registerInvokeRecoveryTerminalEdgeCases(tool: Tool): void {
	it("handles normal done, omitted text_end, dangling transport error, and exhaustion exactly once", async () => {
		for (const [xml, textEnd, terminal] of [
			[`before ${completeInvoke}`, true, "done"],
			[`before ${completeInvoke}`, false, "done"],
			[`before ${danglingInvoke}`, false, "error"],
		] as const) {
			const inner = new EventStream();
			const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
			pushText(inner, xml, textEnd);
			const end = source(xml, 5);
			if (terminal === "done") inner.push({ type: "done", reason: "stop", message: end });
			else {
				end.stopReason = "error";
				end.errorMessage = "transport failed";
				inner.push({ type: "error", reason: "error", error: end });
			}
			const { events } = await collect(wrapped);
			expect(terminalEvents(events)).toHaveLength(1);
			expect(events.filter((event) => event.type === "text_end")).toHaveLength(1);
			expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
		}

		const base = new EventStream();
		pushText(base, danglingInvoke, false);
		const exhausted = new ExhaustedStream(base.queue, source(danglingInvoke, 5));
		const { events, result } = await collect(wrapStreamWithInvokeRecovery(exhausted, [tool]));
		expect(terminalEvents(events)).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			incomplete: true,
			errorMessage: "Tool call stream ended before completion",
		});
	});

	it("finalizes pending recovery once when the consumer cancels", async () => {
		const inner = new CancellableStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		const iterator = wrapped[Symbol.asyncIterator]();
		pushText(inner, danglingInvoke, false);
		expect((await nextEvent(iterator)).type).toBe("start");
		expect((await nextEvent(iterator)).type).toBe("text_start");
		expect((await nextEvent(iterator)).type).toBe("toolcall_start");
		expect(iterator.return).toBeTypeOf("function");
		await iterator.return?.();
		const result = await wrapped.result();

		expect(inner.returnCalls).toBe(1);
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Assistant message stream consumption was cancelled",
		});
		expect(result.content.filter((block) => block.type === "toolCall")).toEqual([]);
	});
}
