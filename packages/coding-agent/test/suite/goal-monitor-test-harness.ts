import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { subscribeGoalFileWrites } from "../../src/core/extensions/builtin/goal/persistence.ts";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageDelivery,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";

type AnyTool = ToolDefinition;
type EventHandler = (data: unknown) => Promise<void> | void;
export type GoalHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
export type SentGoalMessage = {
	readonly message: { readonly customType: string; readonly content: string; readonly display: boolean };
	readonly options: unknown;
	readonly delivery: TestMessageDelivery;
};

export interface TestMessageDelivery extends MessageDelivery {
	readonly state: "pending" | "started" | "cancelled";
	start(): void;
}

let nextDeliveryId = 0;

export class TestEventBus {
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
	readonly #handlers = new Map<string, EventHandler[]>();
	#pending: Promise<void>[] = [];

	emit(channel: string, data: unknown): void {
		this.emitted.push({ channel, data });
		for (const handler of this.#handlers.get(channel) ?? []) {
			this.#pending.push(Promise.resolve(handler(data)));
		}
	}

	on(channel: string, handler: EventHandler): () => void {
		const handlers = this.#handlers.get(channel) ?? [];
		handlers.push(handler);
		this.#handlers.set(channel, handlers);
		return () => {
			const index = handlers.indexOf(handler);
			if (index >= 0) handlers.splice(index, 1);
		};
	}

	async flush(): Promise<void> {
		const pending = this.#pending;
		this.#pending = [];
		await Promise.all(pending);
	}
}

export type AppendedGoalEntry = { readonly customType: string; readonly data: unknown };

const sentCountWaiters = Symbol("sentCountWaiters");

type SentCountWaiter = {
	readonly expectedCount: number;
	readonly complete: (error?: Error) => void;
};

export interface SentMessageHarness {
	readonly sent: SentGoalMessage[];
	readonly sendMessage: (message: SentGoalMessage["message"], options: unknown) => TestMessageDelivery;
	readonly startNext: () => void;
	readonly [sentCountWaiters]: Set<SentCountWaiter>;
}

export interface GoalHarness extends SentMessageHarness {
	readonly tools: Map<string, AnyTool>;
	readonly handlers: Map<string, GoalHandler[]>;
	readonly events: TestEventBus;
	readonly entries: AppendedGoalEntry[];
}

export interface GoalContextState {
	pendingMessages: boolean;
	model?: Model<Api>;
}

export function createSentMessageHarness(): SentMessageHarness {
	const sent: SentGoalMessage[] = [];
	const pendingDeliveries: TestMessageDelivery[] = [];
	const waiters = new Set<SentCountWaiter>();
	const sendMessage = (message: SentGoalMessage["message"], options: unknown): TestMessageDelivery => {
		const delivery = createTestMessageDelivery(pendingDeliveries);
		pendingDeliveries.push(delivery);
		sent.push({ message, options, delivery });
		for (const waiter of waiters) {
			if (sent.length >= waiter.expectedCount) waiter.complete();
		}
		return delivery;
	};
	return {
		sent,
		sendMessage,
		startNext: () => pendingDeliveries.shift()?.start(),
		[sentCountWaiters]: waiters,
	};
}

export function createGoalHarness(): GoalHarness {
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, GoalHandler[]>();
	const messages = createSentMessageHarness();
	const events = new TestEventBus();
	const entries: AppendedGoalEntry[] = [];
	handlers.set("agent_start", [
		() => {
			messages.startNext();
		},
	]);
	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
		on: (event: string, handler: GoalHandler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		sendMessage: messages.sendMessage,
		events,
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	return { tools, handlers, events, entries, ...messages };
}

export function createTestMessageDelivery(pending: TestMessageDelivery[]): TestMessageDelivery {
	const id = `delivery-${++nextDeliveryId}`;
	const started = new Set<() => void>();
	const cancelled = new Set<() => void>();
	let state: TestMessageDelivery["state"] = "pending";
	return {
		id,
		get state() {
			return state;
		},
		cancel() {
			if (state !== "pending") return false;
			state = "cancelled";
			const index = pending.indexOf(this);
			if (index !== -1) pending.splice(index, 1);
			for (const listener of cancelled) listener();
			return true;
		},
		start() {
			if (state !== "pending") return;
			state = "started";
			for (const listener of started) listener();
		},
		onStarted(listener) {
			started.add(listener);
			return () => started.delete(listener);
		},
		onCancelled(listener) {
			cancelled.add(listener);
			return () => cancelled.delete(listener);
		},
	};
}

const tempDirs: string[] = [];

export async function makeGoalContext(
	notices: string[],
	threadId: string,
	state: GoalContextState = { pendingMessages: false },
): Promise<ExtensionContext> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-monitor-"));
	tempDirs.push(dir);
	return {
		hasUI: true,
		cwd: dir,
		model: state.model,
		isIdle: () => true,
		hasPendingMessages: () => state.pendingMessages,
		ui: {
			notify: (message: string) => notices.push(message),
			select: async () => undefined,
			setStatus: () => {},
		},
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => threadId,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
}

export async function cleanupGoalMonitorTempDirs(): Promise<void> {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export function waitForSentCount(
	harness: SentMessageHarness,
	expectedCount: number,
	options: { readonly timeoutMs?: number } = {},
): Promise<void> {
	if (harness.sent.length >= expectedCount) return Promise.resolve();
	const waiters = harness[sentCountWaiters];

	return new Promise((resolve, reject) => {
		let completed = false;
		let timeout: ReturnType<typeof setRealTimeout> | undefined;
		const waiter: SentCountWaiter = { expectedCount, complete };
		waiters.add(waiter);
		timeout = setRealTimeout(
			() => complete(new Error(`Timed out waiting for ${expectedCount} sent goal message(s)`)),
			options.timeoutMs ?? 5_000,
		);

		function complete(error: Error | undefined = undefined): void {
			if (completed) return;
			completed = true;
			if (timeout !== undefined) clearRealTimeout(timeout);
			waiters.delete(waiter);
			if (error === undefined) resolve();
			else reject(error);
		}
	});
}

export function waitForEventCount(
	events: TestEventBus,
	channel: string,
	expectedCount: number,
	options: { readonly timeoutMs?: number } = {},
): Promise<void> {
	const emittedCount = () => events.emitted.filter((event) => event.channel === channel).length;
	if (emittedCount() >= expectedCount) return Promise.resolve();

	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof setRealTimeout> | undefined;
		const unsubscribe = events.on(channel, () => {
			if (emittedCount() >= expectedCount) complete();
		});
		timeout = setRealTimeout(
			() => complete(new Error(`Timed out waiting for ${expectedCount} ${channel} event(s)`)),
			options.timeoutMs ?? 5_000,
		);

		function complete(error: Error | undefined = undefined): void {
			if (timeout === undefined) return;
			clearRealTimeout(timeout);
			timeout = undefined;
			unsubscribe();
			if (error === undefined) resolve();
			else reject(error);
		}
	});
}

export function waitForGoalContinuationCount(ctx: ExtensionContext, expectedCount: number): Promise<void> {
	const baseDir = join(ctx.sessionManager.getSessionDir(), "extensions", "goal");
	const threadId = ctx.sessionManager.getSessionId();
	const ref = { baseDir, threadId };
	return new Promise((resolve, reject) => {
		let completed = false;
		let timeout: ReturnType<typeof setRealTimeout> | undefined;
		const unsubscribe = subscribeGoalFileWrites(ref, () => {
			void check();
		});
		timeout = setRealTimeout(
			() => complete(new Error(`Timed out waiting for continuation count ${expectedCount}`)),
			5_000,
		);
		void check();

		async function check(): Promise<void> {
			try {
				const goal = await readGoal(ref);
				if (goal?.consecutiveContinuations === expectedCount) complete();
			} catch (error) {
				complete(error instanceof Error ? error : new Error(String(error)));
			}
		}

		function complete(error: Error | undefined = undefined): void {
			if (completed) return;
			completed = true;
			if (timeout !== undefined) clearRealTimeout(timeout);
			unsubscribe();
			if (error === undefined) resolve();
			else reject(error);
		}
	});
}

export async function runGoalHandlers(
	handlers: Map<string, GoalHandler[]>,
	event: string,
	payload: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

export type AssistantUsageOverrides = Partial<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}>;

export function cleanAssistantStop(usageOverrides: AssistantUsageOverrides = {}): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...usageOverrides,
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
