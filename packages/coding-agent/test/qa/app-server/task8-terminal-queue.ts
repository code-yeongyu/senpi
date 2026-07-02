import {
	NotificationRouter,
	type RoutableConnection,
	type RoutableThread,
	type RouterNotification,
} from "../../../src/modes/app-server/server/notifications.ts";

class FakeConnection implements RoutableConnection {
	readonly id = "C";
	readonly transport = "ws";
	readonly initialized = true;
	readonly received: RouterNotification[] = [];

	send(notification: RouterNotification): void {
		this.received.push(notification);
	}
}

class SyncWsConnection implements RoutableConnection {
	readonly id = "sync";
	readonly transport = "ws";
	readonly initialized = true;
	readonly received: RouterNotification[] = [];
	readonly closedReasons: string[] = [];

	send(notification: RouterNotification): void {
		this.received.push(notification);
	}

	close(reason: "slow-client"): void {
		this.closedReasons.push(reason);
	}
}

const thread: RoutableThread = {
	id: "t1",
	subscribers: new Set<string>(),
	queuedTerminalNotifications: [],
};
const c = new FakeConnection();
const router = new NotificationRouter({ connections: [c], threads: [thread] });

router.toThread("t1", { method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1" } } });
router.subscribe("t1", "C");

const firstMethod = c.received[0]?.method ?? "NONE";
console.log(`C_FIRST=${firstMethod}`);
if (firstMethod !== "turn/completed") {
	process.exitCode = 1;
}

const syncWs = new SyncWsConnection();
const overflowRouter = new NotificationRouter({ connections: [syncWs], outboundQueueLimit: 1 });
overflowRouter.broadcast({ method: "thread/started", params: { thread: { id: "t1" } } });
overflowRouter.broadcast({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });

const syncMethods = syncWs.received.map((notification) => notification.method).join(",");
const syncCloseReasons = syncWs.closedReasons.join(",");
console.log(`SYNC_WS_GOT=${syncMethods}`);
console.log(`SYNC_WS_CLOSED=${syncCloseReasons || "NONE"}`);
if (syncMethods !== "thread/started,thread/status/changed" || syncCloseReasons !== "") {
	process.exitCode = 1;
}
