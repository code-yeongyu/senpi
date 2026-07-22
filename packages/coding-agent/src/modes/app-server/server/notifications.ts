import { EXPERIMENTAL_SERVER_NOTIFICATION_METHODS } from "../protocol/methods.ts";
import { populateNotificationEnvelope, type RpcNotification, type RpcRequest } from "../rpc/envelope.ts";

export type RouterNotification = RpcNotification;
export type RouterOutboundMessage = RpcNotification | RpcRequest;

export type ConnectionTransport = "stdio" | "ws" | "unix";

export interface RoutableConnection {
	readonly id: string;
	readonly initialized: boolean;
	readonly transport: ConnectionTransport;
	readonly capabilities?: {
		readonly experimentalApi?: boolean;
	};
	readonly optOutNotificationMethods?: readonly string[] | null;
	send(message: RouterOutboundMessage): Promise<void> | void;
	close?(reason: "slow-client"): void;
}

export interface RoutableThread {
	readonly id: string;
	readonly subscribers: Set<string>;
	queuedTerminalNotifications: RouterNotification[];
}

export interface NotificationRouterOptions {
	readonly connections?: Iterable<RoutableConnection>;
	readonly threads?: Iterable<RoutableThread>;
	readonly outboundQueueLimit?: number;
	readonly terminalQueueLimit?: number;
	readonly experimentalNotificationMethods?: Iterable<string>;
	readonly now?: () => number;
}

interface ConnectionState {
	readonly connection: RoutableConnection;
	pending: number;
	closed: boolean;
}

const DEFAULT_OUTBOUND_QUEUE_LIMIT = 32_768;
const DEFAULT_TERMINAL_QUEUE_LIMIT = 100;

const BROADCAST_NOTIFICATION_METHODS = new Set([
	"remoteControl/status/changed",
	"thread/started",
	"thread/status/changed",
	"thread/closed",
	"thread/deleted",
	"thread/archived",
	"thread/unarchived",
	"thread/name/updated",
	"thread/goal/updated",
	"thread/goal/cleared",
	"thread/tokenUsage/updated",
	"fuzzyFileSearch/sessionUpdated",
	"fuzzyFileSearch/sessionCompleted",
]);
const TERMINAL_NOTIFICATION_METHODS = new Set(["turn/completed", "error"]);

export class BroadcastNotificationMethodError extends Error {
	readonly method: string;

	constructor(method: string) {
		super(`Notification method ${method} is not allowed for broadcast`);
		this.name = "BroadcastNotificationMethodError";
		this.method = method;
	}
}

export class NotificationRouter {
	private readonly connections = new Map<string, ConnectionState>();
	private readonly threads = new Map<string, RoutableThread>();
	private readonly outboundQueueLimit: number;
	private readonly terminalQueueLimit: number;
	private readonly experimentalNotificationMethods: ReadonlySet<string>;
	private readonly now: () => number;

	constructor(options: NotificationRouterOptions = {}) {
		this.outboundQueueLimit = options.outboundQueueLimit ?? DEFAULT_OUTBOUND_QUEUE_LIMIT;
		this.terminalQueueLimit = options.terminalQueueLimit ?? DEFAULT_TERMINAL_QUEUE_LIMIT;
		this.experimentalNotificationMethods = new Set(
			options.experimentalNotificationMethods ?? EXPERIMENTAL_SERVER_NOTIFICATION_METHODS,
		);
		this.now = options.now ?? Date.now;
		for (const connection of options.connections ?? []) {
			this.addConnection(connection);
		}
		for (const thread of options.threads ?? []) {
			this.addThread(thread);
		}
	}

	addConnection(connection: RoutableConnection): void {
		this.connections.set(connection.id, {
			connection,
			pending: 0,
			closed: false,
		});
	}

	/**
	 * Removes the connection from every thread subscription. Returns the ids of
	 * threads that lost their last subscriber so the caller can schedule idle
	 * unloads for them (a dropped socket must not keep sessions loaded forever).
	 */
	removeConnection(connectionId: string): string[] {
		this.connections.delete(connectionId);
		const emptiedThreadIds: string[] = [];
		for (const thread of this.threads.values()) {
			if (thread.subscribers.delete(connectionId) && thread.subscribers.size === 0) {
				emptiedThreadIds.push(thread.id);
			}
		}
		return emptiedThreadIds;
	}

	addThread(thread: RoutableThread): void {
		this.threads.set(thread.id, thread);
	}

	/** Drops routing state for an unloaded/deleted thread so the entry (and its session) can be collected. */
	removeThread(threadId: string): void {
		this.threads.delete(threadId);
	}

	subscribe(threadId: string, connectionId: string): void {
		const thread = this.threads.get(threadId);
		if (!thread) {
			return;
		}
		thread.subscribers.add(connectionId);
		const connection = this.connections.get(connectionId);
		if (!connection) {
			return;
		}
		for (const notification of thread.queuedTerminalNotifications) {
			this.enqueue(connection, notification);
		}
		thread.queuedTerminalNotifications = [];
	}

	unsubscribe(threadId: string, connectionId: string): void {
		this.threads.get(threadId)?.subscribers.delete(connectionId);
	}

	broadcast(notification: RouterNotification): void {
		if (!this.canBroadcast(notification.method)) {
			throw new BroadcastNotificationMethodError(notification.method);
		}
		const envelope = populateNotificationEnvelope(notification, this.now());
		for (const state of this.connections.values()) {
			if (state.connection.initialized) {
				this.enqueue(state, envelope);
			}
		}
	}

	toThread(threadId: string, message: RouterOutboundMessage): void {
		const thread = this.threads.get(threadId);
		if (!thread) {
			return;
		}
		const outbound = "id" in message ? message : populateNotificationEnvelope(message, this.now());
		let routed = 0;
		for (const connectionId of thread.subscribers) {
			const state = this.connections.get(connectionId);
			if (state?.connection.initialized) {
				routed += 1;
				this.enqueue(state, outbound);
			}
		}
		if (routed === 0 && !("id" in outbound) && TERMINAL_NOTIFICATION_METHODS.has(outbound.method)) {
			thread.queuedTerminalNotifications.push(outbound);
			while (thread.queuedTerminalNotifications.length > this.terminalQueueLimit) {
				thread.queuedTerminalNotifications.shift();
			}
		}
	}

	private enqueue(state: ConnectionState, message: RouterOutboundMessage): void {
		if (state.closed || (!("id" in message) && this.filtered(state.connection, message))) {
			return;
		}
		if (state.connection.transport !== "stdio" && state.pending >= this.outboundQueueLimit) {
			state.closed = true;
			state.connection.close?.("slow-client");
			return;
		}
		state.pending += 1;
		const sendResult = state.connection.send(message);
		if (sendResult === undefined) {
			state.pending -= 1;
			return;
		}
		sendResult.then(
			() => {
				state.pending -= 1;
			},
			() => {
				state.pending -= 1;
			},
		);
	}

	private canBroadcast(method: string): boolean {
		return BROADCAST_NOTIFICATION_METHODS.has(method);
	}

	private filtered(connection: RoutableConnection, notification: RouterNotification): boolean {
		if (connection.optOutNotificationMethods?.includes(notification.method)) {
			return true;
		}
		return (
			this.experimentalNotificationMethods.has(notification.method) &&
			connection.capabilities?.experimentalApi !== true
		);
	}
}
