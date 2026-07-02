import {
	NotificationRouter,
	type RoutableConnection,
	type RoutableThread,
	type RouterNotification,
} from "../../../src/modes/app-server/server/notifications.ts";

class FakeConnection implements RoutableConnection {
	readonly id: string;
	readonly transport = "ws";
	readonly initialized = true;
	readonly received: RouterNotification[] = [];

	constructor(id: string) {
		this.id = id;
	}

	send(notification: RouterNotification): void {
		this.received.push(notification);
	}
}

const thread: RoutableThread = {
	id: "t1",
	subscribers: new Set(["A"]),
	queuedTerminalNotifications: [],
};
const a = new FakeConnection("A");
const b = new FakeConnection("B");
const router = new NotificationRouter({ connections: [a, b], threads: [thread] });

router.broadcast({ method: "thread/started", params: { thread: { id: "t1" } } });
router.toThread("t1", { method: "turn/started", params: { threadId: "t1", turn: { id: "turn-1" } } });

const bMethods = b.received.map((notification) => notification.method).join(",");
console.log(`B_GOT=${bMethods}`);
if (bMethods !== "thread/started") {
	process.exitCode = 1;
}

let forbiddenBroadcastError: string | null = null;
try {
	router.broadcast({ method: "turn/started", params: { threadId: "t1", turn: { id: "turn-2" } } });
} catch (error: unknown) {
	forbiddenBroadcastError = error instanceof Error ? error.message : String(error);
}

const bMethodsAfterForbiddenBroadcast = b.received.map((notification) => notification.method).join(",");
console.log(`FORBIDDEN_BROADCAST_ERROR=${forbiddenBroadcastError ?? "NONE"}`);
console.log(`B_AFTER_FORBIDDEN_BROADCAST=${bMethodsAfterForbiddenBroadcast}`);
if (
	forbiddenBroadcastError?.includes("not allowed for broadcast") !== true ||
	bMethodsAfterForbiddenBroadcast !== "thread/started"
) {
	process.exitCode = 1;
}
