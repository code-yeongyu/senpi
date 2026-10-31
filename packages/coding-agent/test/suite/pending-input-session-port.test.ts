import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createSessionQueuedInputPort } from "../../src/core/pending-input-session-port.ts";
import type { PendingInputJournal, PendingInputJournalRecord } from "../../src/core/pending-input-store.ts";
import { PendingInputStore } from "../../src/core/pending-input-store.ts";
import type { PendingInputPhase } from "../../src/core/pending-input-types.ts";

// senpi#3549: the session's queued-input port over a real Agent and the store (plan E2, T05, T06, T28).

class MemoryJournal implements PendingInputJournal {
	readonly records: PendingInputJournalRecord[] = [];
	failWhen: ((record: PendingInputJournalRecord) => boolean) | undefined;
	async append(record: PendingInputJournalRecord): Promise<void> {
		if (this.failWhen?.(record)) throw new Error("journal unavailable");
		this.records.push(record);
	}
	async read(): Promise<readonly PendingInputJournalRecord[]> {
		return [...this.records];
	}
	phases(clientMessageId: string): PendingInputPhase[] {
		return this.records.flatMap((record) =>
			[record.input, ...(record.batch ?? [])]
				.filter((input) => input.clientMessageId === clientMessageId)
				.map((input) => input.phase),
		);
	}
}

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function queuedUser(text: string, clientMessageId?: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now(), ...(clientMessageId ? { clientMessageId } : {}) };
}

function texts(messages: readonly AgentMessage[]): string {
	return messages
		.flatMap((message) => {
			if (message.role !== "user") return [];
			if (typeof message.content === "string") return [message.content];
			return [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
		})
		.join("|");
}

async function setup() {
	const journal = new MemoryJournal();
	let queuedIds = 0;
	let attemptIds = 0;
	const store = await PendingInputStore.open({
		journal,
		lifetimeId: "life-1",
		nextQueuedId: () => `q_${++queuedIds}`,
	});
	const requests: { texts: string; phases: PendingInputPhase[] }[] = [];
	const streamFn: StreamFn = (_model, context) => {
		requests.push({ texts: texts(context.messages), phases: journal.phases("c-1") });
		const stream = new MockAssistantStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant() }));
		return stream;
	};
	const port = createSessionQueuedInputPort({
		store,
		ownerId: "owner-1",
		writerGeneration: 1,
		nextAttemptId: () => `a-${++attemptIds}`,
	});
	const agent = new Agent({ streamFn, queuedInputPort: port });
	return { journal, store, agent, requests };
}

const SUBMIT = {
	clientMessageId: "c-1",
	fingerprint: "fp",
	text: "later",
	attachments: [],
	requestedMode: "followUp",
} as const;

describe("session queued-input port", () => {
	it("journals the reservation and the consumption before the provider sees the input", async () => {
		const { journal, store, agent, requests } = await setup();
		await store.submit(SUBMIT);
		agent.followUp(queuedUser("later", "c-1"));

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first", "first|later"]);
		expect(requests[1]?.phases).toEqual(["queued", "sending", "delivered"]);
		expect(store.read("c-1")).toMatchObject({ status: "admitted", projection: { state: "delivered" } });
		expect(journal.phases("c-1")).toEqual(["queued", "sending", "delivered"]);
	});

	it("does not deliver a native copy the store already removed", async () => {
		const { store, agent, requests } = await setup();
		await store.submit(SUBMIT);
		await store.apply("c-1", {
			type: "remove",
			effectId: "e-1",
			handle: { lifetimeId: "life-1", queuedId: "q_1" },
			expectedRevision: 1,
		});
		agent.followUp(queuedUser("later", "c-1"));

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first"]);
		expect(store.read("c-1")).toMatchObject({ projection: { state: "removed" } });
	});

	it("returns a claimed input to its queue, same id, when its consumption cannot be committed (T28)", async () => {
		const { journal, store, agent, requests } = await setup();
		await store.submit(SUBMIT);
		agent.followUp(queuedUser("later", "c-1"));
		journal.failWhen = (record) => record.input.phase === "delivered";

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first"]);
		expect(journal.phases("c-1")).toEqual(["queued", "sending", "queued"]);
		expect(store.read("c-1")).toMatchObject({ projection: { state: "queued" } });
		expect(texts(agent.peekQueuedMessages())).toBe("later");
	});

	it("records a claimed input removed in ONE record when a clear won before the give-back (review H1, L-a)", async () => {
		const { journal, store } = await setup();
		await store.submit(SUBMIT);
		const port = createSessionQueuedInputPort({
			store,
			ownerId: "owner-1",
			writerGeneration: 1,
			nextAttemptId: () => "a-x",
		});
		const claimed = await port.claim("followUp", () => [queuedUser("later", "c-1")]);

		const recordsBefore = journal.records.length;

		await port.release("followUp", claimed, { restorable: () => false, restore: () => false });

		expect(journal.phases("c-1")).toEqual(["queued", "sending", "removed"]);
		expect(journal.records.length - recordsBefore).toBe(1);
		expect(store.read("c-1")).toMatchObject({ projection: { state: "removed" } });
	});

	it("removes a released input when a clear lands during the release's own write", async () => {
		const { journal, store } = await setup();
		await store.submit(SUBMIT);
		const port = createSessionQueuedInputPort({
			store,
			ownerId: "owner-1",
			writerGeneration: 1,
			nextAttemptId: () => "a-x",
		});
		const claimed = await port.claim("followUp", () => [queuedUser("later", "c-1")]);

		await port.release("followUp", claimed, { restorable: () => true, restore: () => false });

		expect(journal.phases("c-1")).toEqual(["queued", "sending", "queued", "removed"]);
		expect(store.read("c-1")).toMatchObject({ projection: { state: "removed" } });
	});

	it("commits a batch's consumption in one record: a failed write leaves every input queued (review H2)", async () => {
		const { journal, store, agent, requests } = await setup();
		agent.followUpMode = "all";
		await store.submit(SUBMIT);
		await store.submit({ ...SUBMIT, clientMessageId: "c-2", fingerprint: "fp2", text: "also" });
		agent.followUp(queuedUser("later", "c-1"));
		agent.followUp(queuedUser("also", "c-2"));
		// Only the write that records c-2 delivered fails: a batch committed input by input would leave c-1 delivered.
		journal.failWhen = (record) =>
			[record.input, ...(record.batch ?? [])].some(
				(input) => input.clientMessageId === "c-2" && input.phase === "delivered",
			);

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first"]);
		expect(store.read("c-1")).toMatchObject({ projection: { state: "queued" } });
		expect(store.read("c-2")).toMatchObject({ projection: { state: "queued" } });
		expect(texts(agent.peekQueuedMessages())).toBe("later|also");
	});

	it("notifies a batch once, with every input it changed under its one cursor (review L-b)", async () => {
		const { store, agent } = await setup();
		agent.followUpMode = "all";
		await store.submit(SUBMIT);
		await store.submit({ ...SUBMIT, clientMessageId: "c-2", fingerprint: "fp2", text: "also" });
		agent.followUp(queuedUser("later", "c-1"));
		agent.followUp(queuedUser("also", "c-2"));
		const notifications: { cursor: number; changes: string[] }[] = [];
		store.subscribe((projections, cursor) =>
			notifications.push({
				cursor,
				changes: projections.map((projection) => `${projection.clientMessageId}:${projection.state}`),
			}),
		);

		await agent.prompt("first");

		const delivered = notifications.filter((notification) =>
			notification.changes.some((change) => change.endsWith(":delivered")),
		);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.changes).toEqual(["c-1:delivered", "c-2:delivered"]);
	});

	it("delivers a batch with one record that names every input", async () => {
		const { journal, store, agent } = await setup();
		agent.followUpMode = "all";
		await store.submit(SUBMIT);
		await store.submit({ ...SUBMIT, clientMessageId: "c-2", fingerprint: "fp2", text: "also" });
		agent.followUp(queuedUser("later", "c-1"));
		agent.followUp(queuedUser("also", "c-2"));

		await agent.prompt("first");

		const delivered = journal.records.filter((record) => record.input.phase === "delivered");
		expect(delivered).toHaveLength(1);
		expect([delivered[0]?.input, ...(delivered[0]?.batch ?? [])].map((input) => input?.clientMessageId)).toEqual([
			"c-1",
			"c-2",
		]);
	});

	it("an abort while a claim is held leaves the input delivered and sent once, or queued with its native copy (review M2)", async () => {
		const { journal, store, agent, requests } = await setup();
		await store.submit(SUBMIT);
		agent.followUp(queuedUser("later", "c-1"));
		const originalAppend = journal.append.bind(journal);
		journal.append = async (record) => {
			await originalAppend(record);
			if (record.input.phase === "sending") agent.abort();
		};

		await agent.prompt("first").catch(() => undefined);
		await agent.waitForIdle();

		const state = store.read("c-1");
		const sent = requests.some((request) => request.texts.includes("later"));
		const nativeCopy = texts(agent.peekQueuedMessages()) === "later";
		expect(state.status).toBe("admitted");
		if (state.status !== "admitted") return;
		expect(["delivered", "queued"]).toContain(state.projection.state);
		// Delivered means it reached exactly one request and left the queue; queued means it was never sent.
		const delivered = state.projection.state === "delivered";
		expect({ sent, nativeCopy }).toEqual(
			delivered ? { sent: true, nativeCopy: false } : { sent: false, nativeCopy: true },
		);
		expect(requests.filter((request) => request.texts.endsWith("later"))).toHaveLength(delivered ? 1 : 0);
	});

	it("passes input the store never admitted straight through", async () => {
		const { journal, agent, requests } = await setup();
		agent.followUp(queuedUser("legacy"));

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first", "first|legacy"]);
		expect(journal.records).toEqual([]);
	});
});
