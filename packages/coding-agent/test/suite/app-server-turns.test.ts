import { describe, expect, it } from "vitest";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	createTurnEngine,
	TurnEngineError,
	type TurnEngineNotification,
	type TurnEngineSession,
	type TurnEngineStore,
} from "../../src/modes/app-server/threads/turns.ts";

class ScriptedSession implements TurnEngineSession {
	readonly promptCalls: Array<{ readonly text: string; readonly source: string | undefined }> = [];
	readonly steerCalls: string[] = [];
	abortCalls = 0;
	promptPreflightResult = true;
	promptError: Error | null = null;
	private readonly listeners: Array<(event: { readonly type: string }) => void> = [];

	async prompt(
		text: string,
		options?: { readonly source?: string; readonly preflightResult?: (success: boolean) => void },
	): Promise<void> {
		this.promptCalls.push({ text, source: options?.source });
		options?.preflightResult?.(this.promptPreflightResult);
		if (this.promptError) {
			throw this.promptError;
		}
	}

	async steer(text: string): Promise<void> {
		this.steerCalls.push(text);
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
		this.emitAgentEnd();
	}

	subscribe(listener: (event: { readonly type: string }) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.splice(index, 1);
			}
		};
	}

	emit(event: { readonly type: string }): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	emitAgentEnd(): void {
		this.emit({ type: "agent_end" });
	}
}

type FakeEntry = {
	readonly id: string;
	readonly session: ScriptedSession;
	activeTurn: { readonly turnId: string; readonly startedAt: string } | null;
	status: "idle" | "active";
	updatedAt: string;
	taskQueue: Promise<void>;
};

class FakeStore implements TurnEngineStore<FakeEntry> {
	private readonly entries = new Map<string, FakeEntry>();

	add(threadId: string, session = new ScriptedSession()): FakeEntry {
		const entry: FakeEntry = {
			id: threadId,
			session,
			activeTurn: null,
			status: "idle",
			updatedAt: "2026-07-02T00:00:00.000Z",
			taskQueue: Promise.resolve(),
		};
		this.entries.set(threadId, entry);
		return entry;
	}

	getLoadedThread(threadId: string): FakeEntry {
		const entry = this.entries.get(threadId);
		if (!entry) {
			throw new Error(`missing thread ${threadId}`);
		}
		return entry;
	}

	runThreadTask<T>(threadId: string, task: () => Promise<T> | T): Promise<T> {
		const entry = this.getLoadedThread(threadId);
		const run = entry.taskQueue.then(task, task);
		entry.taskQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

function createHarness(): {
	readonly engine: ReturnType<typeof createTurnEngine<FakeEntry>>;
	readonly store: FakeStore;
	readonly notifications: TurnEngineNotification[];
	readonly turnLog: TurnLog;
} {
	const store = new FakeStore();
	const turnLog = new TurnLog();
	const notifications: TurnEngineNotification[] = [];
	return {
		store,
		notifications,
		turnLog,
		engine: createTurnEngine({
			store,
			turnLog,
			emitToThread: (_threadId, notification) => notifications.push(notification),
			broadcast: (notification) => notifications.push(notification),
		}),
	};
}

describe("app-server turn engine", () => {
	it("emits the happy turn lifecycle in order and completes on agent_end", async () => {
		const { engine, store, notifications } = createHarness();
		const entry = store.add("thread-a");

		const response = await engine.startTurn({
			threadId: "thread-a",
			clientUserMessageId: "client-user-1",
			input: [{ type: "text", text: "hello", text_elements: [] }],
		});

		expect(response.turn.status).toBe("inProgress");
		expect(response.turn.items).toEqual([]);
		expect(entry.activeTurn?.turnId).toBe(response.turn.id);
		expect(entry.status).toBe("active");
		expect(entry.session.promptCalls).toEqual([{ text: "hello", source: "rpc" }]);
		expect(notifications.map((notification) => notification.method)).toEqual([
			"thread/status/changed",
			"turn/started",
			"item/started",
			"item/completed",
		]);

		entry.session.emitAgentEnd();
		await entry.taskQueue;

		expect(entry.activeTurn).toBeNull();
		expect(entry.status).toBe("idle");
		expect(notifications.map((notification) => notification.method)).toEqual([
			"thread/status/changed",
			"turn/started",
			"item/started",
			"item/completed",
			"thread/status/changed",
			"turn/completed",
		]);
		expect(notifications[2]?.params).toMatchObject({
			threadId: "thread-a",
			turnId: response.turn.id,
			item: {
				type: "userMessage",
				clientId: "client-user-1",
				content: [{ type: "text", text: "hello", text_elements: [] }],
			},
		});
	});

	it("rejects stale steering without calling the session", async () => {
		const { engine, store } = createHarness();
		const entry = store.add("thread-a");
		const started = await engine.startTurn({ threadId: "thread-a", input: [{ type: "text", text: "hello" }] });

		await expect(
			engine.steerTurn({
				threadId: "thread-a",
				expectedTurnId: "stale-id",
				input: [{ type: "text", text: "steer" }],
			}),
		).rejects.toMatchObject({
			error: {
				code: -32600,
				message: expect.stringContaining(`expected stale-id but active turn is ${started.turn.id}`),
			},
		});
		expect(entry.session.steerCalls).toEqual([]);
		entry.session.emitAgentEnd();
		await entry.taskQueue;
	});

	it("logs successful steering on the active turn without turn/started", async () => {
		const { engine, store, notifications, turnLog } = createHarness();
		const entry = store.add("thread-a");
		const started = await engine.startTurn({
			threadId: "thread-a",
			clientUserMessageId: "client-user-1",
			input: [{ type: "text", text: "hello" }],
		});
		notifications.length = 0;

		await expect(
			engine.steerTurn({
				threadId: "thread-a",
				expectedTurnId: started.turn.id,
				clientUserMessageId: "client-steer-1",
				input: [{ type: "text", text: "steer", text_elements: [] }],
			}),
		).resolves.toEqual({ turnId: started.turn.id });

		expect(entry.session.steerCalls).toEqual(["steer"]);
		expect(notifications.map((notification) => notification.method)).toEqual(["item/started", "item/completed"]);
		expect(notifications[0]?.params).toMatchObject({
			threadId: "thread-a",
			turnId: started.turn.id,
			item: { id: "client-steer-1", clientId: "client-steer-1", type: "userMessage" },
		});
		expect(turnLog.readTurns("thread-a")[0]?.items).toMatchObject([
			{ type: "userMessage", clientId: "client-user-1" },
			{ type: "userMessage", clientId: "client-steer-1" },
		]);
		entry.session.emitAgentEnd();
		await entry.taskQueue;
	});

	it("rejects turn start before acknowledgement when prompt preflight fails", async () => {
		const { engine, store } = createHarness();
		const entry = store.add("thread-a");
		entry.session.promptPreflightResult = false;
		entry.session.promptError = new Error("missing model");

		await expect(
			engine.startTurn({ threadId: "thread-a", input: [{ type: "text", text: "hello" }] }),
		).rejects.toMatchObject({ error: { code: -32603, message: "missing model" } });
		await entry.taskQueue;
		expect(entry.activeTurn).toBeNull();
		expect(entry.status).toBe("idle");
	});

	it("tolerates interrupt after the active turn already ended", async () => {
		const { engine, store } = createHarness();
		const entry = store.add("thread-a");
		const started = await engine.startTurn({ threadId: "thread-a", input: [{ type: "text", text: "hello" }] });
		entry.session.emitAgentEnd();
		await entry.taskQueue;

		await expect(engine.interruptTurn({ threadId: "thread-a", turnId: started.turn.id })).resolves.toEqual({});
		expect(entry.session.abortCalls).toBe(0);
	});

	it("queues a second turn/start behind the active turn", async () => {
		const { engine, store, notifications } = createHarness();
		const entry = store.add("thread-a");
		const first = await engine.startTurn({ threadId: "thread-a", input: [{ type: "text", text: "first" }] });
		const secondPromise = engine.startTurn({ threadId: "thread-a", input: [{ type: "text", text: "second" }] });

		await Promise.resolve();
		expect(entry.session.promptCalls.map((call) => call.text)).toEqual(["first"]);
		expect(notifications.filter((notification) => notification.method === "turn/started")).toHaveLength(1);

		entry.session.emitAgentEnd();
		const second = await secondPromise;
		expect(second.turn.id).not.toBe(first.turn.id);
		expect(entry.session.promptCalls.map((call) => call.text)).toEqual(["first", "second"]);
		expect(notifications.filter((notification) => notification.method === "turn/started")).toHaveLength(2);

		entry.session.emitAgentEnd();
		await entry.taskQueue;
	});

	it("rejects unknown input item types as invalid params", async () => {
		const { engine, store } = createHarness();
		store.add("thread-a");

		await expect(
			engine.startTurn({
				threadId: "thread-a",
				input: [{ type: "skill", name: "nope", path: "/tmp/nope" }],
			}),
		).rejects.toBeInstanceOf(TurnEngineError);
	});

	it("projects assistant message events into item notifications and the turn log", async () => {
		// Given: a started turn on a live session.
		const { engine, store, notifications } = createHarness();
		const entry = store.add("thread-a");
		const response = await engine.startTurn({ threadId: "thread-a", input: [{ type: "text", text: "hi" }] });

		// When: the session streams an assistant message and the run ends.
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "mock answer" }],
			responseId: "msg-1",
		};
		entry.session.emit({ type: "message_start", message } as { type: string });
		entry.session.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message },
		} as { type: string });
		entry.session.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "mock answer", partial: message },
		} as { type: string });
		entry.session.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "mock answer", partial: message },
		} as { type: string });
		entry.session.emitAgentEnd();
		await entry.taskQueue;

		// Then: the agent message reaches the wire as item notifications.
		const methods = notifications.map((notification) => notification.method);
		expect(methods).toContain("item/agentMessage/delta");
		const delta = notifications.find((notification) => notification.method === "item/agentMessage/delta");
		expect(delta?.params).toMatchObject({ threadId: "thread-a", turnId: response.turn.id, delta: "mock answer" });
		const completedItems = notifications
			.filter((notification) => notification.method === "item/completed")
			.map((notification) => (notification.params as { item: { type: string } }).item);
		expect(completedItems.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);

		// And: turn/completed serves the same agent message item from the turn log.
		const turnCompleted = notifications.find((notification) => notification.method === "turn/completed");
		const turn = (turnCompleted?.params as { turn: { items: Array<{ type: string; text?: string }> } }).turn;
		expect(turn.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
		expect(turn.items[1]?.text).toBe("mock answer");
	});

	it("closes dangling tool items before turn/completed when execution never finished", async () => {
		// Given: a turn whose assistant message requested a tool that never executed.
		const { engine, store, notifications } = createHarness();
		const entry = store.add("thread-a");
		await engine.startTurn({ threadId: "thread-a", input: [{ type: "text", text: "run it" }] });
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo hi" } }],
			responseId: "msg-1",
		};
		entry.session.emit({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo hi" } },
				partial: message,
			},
		} as { type: string });

		// When: the run ends without a tool_execution_end.
		entry.session.emitAgentEnd();
		await entry.taskQueue;

		// Then: the dangling tool item completes before turn/completed, and the turn carries it.
		const methods = notifications.map((notification) => notification.method);
		const toolCompletedIndex = methods.lastIndexOf("item/completed");
		const turnCompletedIndex = methods.indexOf("turn/completed");
		expect(toolCompletedIndex).toBeGreaterThan(-1);
		expect(toolCompletedIndex).toBeLessThan(turnCompletedIndex);
		const turnCompleted = notifications.find((notification) => notification.method === "turn/completed");
		const turn = (turnCompleted?.params as { turn: { items: Array<{ type: string }> } }).turn;
		expect(turn.items.map((item) => item.type)).toEqual(["userMessage", "commandExecution"]);
	});
});
