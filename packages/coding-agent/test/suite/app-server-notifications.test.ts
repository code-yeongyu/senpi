import { describe, expect, it } from "vitest";
import {
	NotificationRouter,
	type RoutableConnection,
	type RoutableThread,
	type RouterNotification,
} from "../../src/modes/app-server/server/notifications.ts";

class FakeConnection implements RoutableConnection {
	readonly id: string;
	readonly transport: "stdio" | "ws" | "unix";
	readonly received: RouterNotification[] = [];
	readonly closedReasons: string[] = [];
	initialized = true;
	optOutNotificationMethods: readonly string[] | null = null;
	capabilities: { readonly experimentalApi?: boolean } = {};
	private readonly holdSends: boolean;

	constructor(options: {
		readonly id: string;
		readonly transport?: "stdio" | "ws" | "unix";
		readonly initialized?: boolean;
		readonly optOutNotificationMethods?: readonly string[] | null;
		readonly experimentalApi?: boolean;
		readonly holdSends?: boolean;
	}) {
		this.id = options.id;
		this.transport = options.transport ?? "ws";
		this.initialized = options.initialized ?? true;
		this.optOutNotificationMethods = options.optOutNotificationMethods ?? null;
		this.capabilities = { experimentalApi: options.experimentalApi };
		this.holdSends = options.holdSends ?? false;
	}

	send(notification: RouterNotification): Promise<void> | void {
		this.received.push(notification);
		if (!this.holdSends) {
			return;
		}
		return new Promise<void>(() => undefined);
	}

	close(reason: string): void {
		this.closedReasons.push(reason);
	}
}

function thread(id: string): RoutableThread {
	return {
		id,
		subscribers: new Set<string>(),
		queuedTerminalNotifications: [],
	};
}

const lifecycleNotification: RouterNotification = {
	method: "thread/started",
	params: { thread: { id: "t1" } },
};

const turnNotification: RouterNotification = {
	method: "turn/started",
	params: { threadId: "t1", turn: { id: "turn-1" } },
};

describe("app-server notification router", () => {
	it("broadcasts lifecycle notifications while scoping turn notifications to thread subscribers", () => {
		// Given: two initialized connections and one subscriber to thread t1.
		const entry = thread("t1");
		entry.subscribers.add("A");
		const a = new FakeConnection({ id: "A" });
		const b = new FakeConnection({ id: "B" });
		const router = new NotificationRouter({ connections: [a, b], threads: [entry] });

		// When: lifecycle and turn notifications are routed.
		router.broadcast(lifecycleNotification);
		router.toThread("t1", turnNotification);

		// Then: lifecycle reaches both, while turn stream only reaches A.
		expect(a.received.map((notification) => notification.method)).toEqual(["thread/started", "turn/started"]);
		expect(b.received.map((notification) => notification.method)).toEqual(["thread/started"]);
	});

	it("rejects globally broadcast turn notifications without delivering them", () => {
		// Given: two initialized connections with no thread subscription context.
		const a = new FakeConnection({ id: "A" });
		const b = new FakeConnection({ id: "B" });
		const router = new NotificationRouter({ connections: [a, b] });

		// When/Then: misrouting a scoped turn notification through broadcast fails clearly.
		expect(() => router.broadcast(turnNotification)).toThrow(/not allowed for broadcast/);
		expect(a.received).toEqual([]);
		expect(b.received).toEqual([]);
	});

	it("queues terminal notifications with zero subscribers and flushes them before live events on subscribe", () => {
		// Given: a thread with no subscribers and two terminal notifications.
		const entry = thread("t1");
		const c = new FakeConnection({ id: "C" });
		const router = new NotificationRouter({ connections: [c], threads: [entry] });

		// When: terminal events happen before C subscribes, then a live event follows.
		router.toThread("t1", { method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1" } } });
		router.toThread("t1", { method: "error", params: { threadId: "t1", turnId: "turn-2", error: "failed" } });
		router.subscribe("t1", "C");
		router.toThread("t1", turnNotification);

		// Then: queued terminal events flush in FIFO order before the live turn event.
		expect(c.received.map((notification) => notification.method)).toEqual([
			"turn/completed",
			"error",
			"turn/started",
		]);
		expect(entry.queuedTerminalNotifications).toEqual([]);
	});

	it("bounds queued terminal notifications at 100 and evicts oldest entries", () => {
		// Given: a thread without subscribers.
		const entry = thread("t1");
		const c = new FakeConnection({ id: "C" });
		const router = new NotificationRouter({ connections: [c], threads: [entry] });

		// When: more terminal events arrive than the terminal queue limit.
		for (let index = 0; index < 101; index++) {
			router.toThread("t1", {
				method: "turn/completed",
				params: { threadId: "t1", turn: { id: `turn-${index}` } },
			});
		}
		router.subscribe("t1", "C");

		// Then: the oldest event was evicted and the newest 100 are flushed.
		expect(c.received).toHaveLength(100);
		expect(c.received[0]?.params).toEqual({ threadId: "t1", turn: { id: "turn-1" } });
		expect(c.received[99]?.params).toEqual({ threadId: "t1", turn: { id: "turn-100" } });
	});

	it("closes slow websocket clients at the outbound bound without disconnecting stdio", () => {
		// Given: slow websocket and stdio connections with a one-message outbound bound.
		const ws = new FakeConnection({ id: "ws", holdSends: true, transport: "ws" });
		const stdio = new FakeConnection({ id: "stdio", holdSends: true, transport: "stdio" });
		const router = new NotificationRouter({ connections: [ws, stdio], outboundQueueLimit: 1 });

		// When: a second message is enqueued while the first is still pending.
		router.broadcast(lifecycleNotification);
		router.broadcast({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });

		// Then: ws closes as slow-client, while stdio remains connected and queued.
		expect(ws.closedReasons).toEqual(["slow-client"]);
		expect(ws.received.map((notification) => notification.method)).toEqual(["thread/started"]);
		expect(stdio.closedReasons).toEqual([]);
		expect(stdio.received.map((notification) => notification.method)).toEqual([
			"thread/started",
			"thread/status/changed",
		]);
	});

	it("does not count synchronous websocket sends as queued backlog", () => {
		// Given: a websocket connection whose send completes synchronously and a one-message outbound bound.
		const ws = new FakeConnection({ id: "ws", transport: "ws" });
		const router = new NotificationRouter({ connections: [ws], outboundQueueLimit: 1 });

		// When: multiple lifecycle notifications are sent back-to-back.
		router.broadcast(lifecycleNotification);
		router.broadcast({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });

		// Then: the synchronous sender is not mistaken for a slow client.
		expect(ws.closedReasons).toEqual([]);
		expect(ws.received.map((notification) => notification.method)).toEqual([
			"thread/started",
			"thread/status/changed",
		]);
	});

	it("honors optOutNotificationMethods without dropping terminal queue guarantees", () => {
		// Given: one connection opted out of warnings and another opted out of turn/completed.
		const entry = thread("t1");
		entry.subscribers.add("A");
		entry.subscribers.add("B");
		const a = new FakeConnection({ id: "A", optOutNotificationMethods: ["warning"] });
		const b = new FakeConnection({ id: "B", optOutNotificationMethods: ["turn/completed"] });
		const router = new NotificationRouter({ connections: [a, b], threads: [entry] });

		// When: warning and terminal events are routed to the subscribed thread.
		router.toThread("t1", { method: "warning", params: { threadId: "t1", message: "careful" } });
		router.toThread("t1", { method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1" } } });

		// Then: each connection receives only the methods it did not opt out of.
		expect(a.received.map((notification) => notification.method)).toEqual(["turn/completed"]);
		expect(b.received.map((notification) => notification.method)).toEqual(["warning"]);
		expect(entry.queuedTerminalNotifications).toEqual([]);
	});

	it("filters experimental notifications unless a connection opts into experimentalApi", () => {
		// Given: two initialized connections with different experimental capability settings.
		const stable = new FakeConnection({ id: "stable", experimentalApi: false });
		const experimental = new FakeConnection({ id: "experimental", experimentalApi: true });
		const router = new NotificationRouter({ connections: [stable, experimental] });

		// When: an experimental notification is broadcast.
		router.broadcast({ method: "remoteControl/status/changed", params: { status: "inactive" } });

		// Then: only the experimental-capable connection receives it.
		expect(stable.received).toEqual([]);
		expect(experimental.received.map((notification) => notification.method)).toEqual([
			"remoteControl/status/changed",
		]);
	});
});
