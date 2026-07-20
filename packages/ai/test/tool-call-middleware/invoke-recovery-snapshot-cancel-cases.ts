import { expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../../src/types.ts";
import { AssistantMessageEventStream as EventStream } from "../../src/utils/event-stream.ts";
import { nextEvent } from "./invoke-recovery-stream-fixtures.ts";
import { completeInvoke, danglingInvoke, pushText, source } from "./invoke-recovery-termination-cases.ts";

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
	let resolvePromise: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

type SharedNode = { value: number };
type CyclicNode = { label: string; shared: SharedNode; self?: CyclicNode };
type SnapshotMessage = AssistantMessage & {
	custom: {
		nested: { value: number };
		items: Array<{ value: number }>;
		sharedA: SharedNode;
		sharedB: SharedNode;
		cycle: CyclicNode;
	};
};

function snapshotMessage(): SnapshotMessage {
	const shared = { value: 3 };
	const cycle: CyclicNode = { label: "cycle", shared };
	cycle.self = cycle;
	const message = source("", 1) as SnapshotMessage;
	message.diagnostics = [
		{
			type: "existing_diagnostic",
			timestamp: 1,
			details: { nested: { value: 4 }, items: [{ value: 5 }] },
			message: "original diagnostic",
		} as AssistantMessage["diagnostics"] extends Array<infer Diagnostic> ? Diagnostic : never,
	];
	message.custom = {
		nested: { value: 1 },
		items: [{ value: 2 }],
		sharedA: shared,
		sharedB: shared,
		cycle,
	};
	return message;
}

function eventMessage(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

class DeferredCleanupStream extends EventStream {
	readonly cleanupStarted = deferred<void>();
	readonly releaseCleanup = deferred<void>();
	returnCalls = 0;

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const iterator = super[Symbol.asyncIterator]();
		return {
			next: () => iterator.next(),
			return: async () => {
				this.returnCalls += 1;
				this.cleanupStarted.resolve();
				await this.releaseCleanup.promise;
				return { value: undefined, done: true };
			},
		};
	}
}

class ReturnCountingStream extends EventStream {
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

async function consume(stream: EventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

export function registerInvokeRecoverySnapshotCancelCases(tool: Tool): void {
	it("snapshots nested metadata and diagnostics for every emitted event", async () => {
		const inner = new EventStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		const iterator = wrapped[Symbol.asyncIterator]();
		const sourceMessage = snapshotMessage();
		const snapshots: Array<{
			message: SnapshotMessage;
			nested: number;
			item: number;
			diagnostic: string;
			shared: number;
			usageInput: number;
			costInput: number;
			responseId: string | undefined;
		}> = [];

		const capture = async (): Promise<void> => {
			const event = await nextEvent(iterator);
			const message = eventMessage(event) as SnapshotMessage;
			const diagnostic = message.diagnostics?.[0] as
				| (NonNullable<AssistantMessage["diagnostics"]>[number] & {
						message: string;
				  })
				| undefined;
			snapshots.push({
				message,
				nested: message.custom.nested.value,
				item: message.custom.items[0]!.value,
				diagnostic: diagnostic?.message ?? "",
				shared: message.custom.sharedA.value,
				usageInput: message.usage.input,
				costInput: message.usage.cost.input,
				responseId: message.responseId,
			});
			expect(message.custom.sharedA).toBe(message.custom.sharedB);
			expect(message.custom.cycle.self).toBe(message.custom.cycle);
			expect(message.custom.cycle.shared).toBe(message.custom.sharedA);
			if (snapshots.length === 1) {
				expect(sourceMessage.custom.nested.value).toBe(1);
				expect(sourceMessage.custom.items[0]!.value).toBe(2);
				expect(sourceMessage.custom.sharedA.value).toBe(3);
			}
			sourceMessage.custom.nested.value += 10;
			sourceMessage.custom.items[0]!.value += 10;
			sourceMessage.custom.sharedA.value += 10;
			sourceMessage.usage.input += 10;
			sourceMessage.usage.cost.input += 10;
			sourceMessage.responseId = `mutated-response-${snapshots.length}`;
			const sourceDiagnostic = sourceMessage.diagnostics?.[0] as
				| (NonNullable<AssistantMessage["diagnostics"]>[number] & {
						message: string;
				  })
				| undefined;
			if (sourceDiagnostic) sourceDiagnostic.message = `mutated-${snapshots.length}`;
			for (const snapshot of snapshots) {
				expect(snapshot.message.custom.nested.value).toBe(snapshot.nested);
				expect(snapshot.message.custom.items[0]!.value).toBe(snapshot.item);
				expect(snapshot.message.custom.sharedA.value).toBe(snapshot.shared);
				expect(snapshot.message.usage.input).toBe(snapshot.usageInput);
				expect(snapshot.message.usage.cost.input).toBe(snapshot.costInput);
				expect(snapshot.message.responseId).toBe(snapshot.responseId);
				const priorDiagnostic = snapshot.message.diagnostics?.[0] as
					| (NonNullable<AssistantMessage["diagnostics"]>[number] & { message: string })
					| undefined;
				expect(priorDiagnostic?.message).toBe(snapshot.diagnostic);
			}
		};

		inner.push({ type: "start", partial: sourceMessage });
		await capture();
		sourceMessage.content.push({ type: "text", text: "" });
		inner.push({ type: "text_start", contentIndex: 0, partial: sourceMessage });
		await capture();
		sourceMessage.content[0] = { type: "text", text: completeInvoke };
		inner.push({ type: "text_delta", contentIndex: 0, delta: completeInvoke, partial: sourceMessage });
		await capture();
		await capture();
		await capture();
		const done = sourceMessage;
		done.stopReason = "stop";
		inner.push({ type: "done", reason: "stop", message: done });
		await capture();
		const result = (await wrapped.result()) as SnapshotMessage;
		const resultNested = result.custom.nested.value;
		sourceMessage.custom.nested.value += 100;
		expect(result.custom.nested.value).toBe(resultNested);
		expect(sourceMessage.content[0]).toEqual({ type: "text", text: completeInvoke });
	});

	it("awaits upstream iterator cleanup before cancellation settles", async () => {
		const inner = new DeferredCleanupStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		const iterator = wrapped[Symbol.asyncIterator]();
		pushText(inner, danglingInvoke, false);
		await nextEvent(iterator);
		await nextEvent(iterator);
		await nextEvent(iterator);
		let cancelSettled = false;
		let repeatedCancelSettled = false;
		let resultSettled = false;
		const cancelPromise = iterator.return?.().then(() => {
			cancelSettled = true;
		});
		void wrapped.result().then(() => {
			resultSettled = true;
		});
		await inner.cleanupStarted.promise;
		inner.push({ type: "done", reason: "stop", message: source(danglingInvoke, 5) });
		const repeatedCancel = Promise.all([iterator.return?.(), wrapped[Symbol.asyncIterator]().return?.()]).then(() => {
			repeatedCancelSettled = true;
		});
		await Promise.resolve();
		expect(cancelSettled).toBe(false);
		expect(repeatedCancelSettled).toBe(false);
		expect(resultSettled).toBe(false);
		inner.releaseCleanup.resolve();
		await Promise.all([cancelPromise, repeatedCancel]);
		const result = await wrapped.result();
		expect(inner.returnCalls).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("does not cancel upstream again after source terminal", async () => {
		const inner = new ReturnCountingStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [tool]);
		pushText(inner, completeInvoke, true);
		inner.push({ type: "done", reason: "stop", message: source(completeInvoke, 5) });
		await consume(wrapped);
		expect(inner.returnCalls).toBe(1);
		const iterator = wrapped[Symbol.asyncIterator]();
		await Promise.all([iterator.return?.(), iterator.return?.(), wrapped[Symbol.asyncIterator]().return?.()]);
		expect(inner.returnCalls).toBe(1);
	});
}
