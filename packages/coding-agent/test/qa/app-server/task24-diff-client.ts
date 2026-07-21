import WebSocket, { type RawData } from "ws";

export type WireRecord = Record<string, unknown>;

type PendingResponse = {
	readonly resolve: (response: WireRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: NodeJS.Timeout;
};

type NotificationWaiter = {
	readonly predicate: (notification: WireRecord) => boolean;
	readonly resolve: (notification: WireRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: NodeJS.Timeout;
};

export class Task24Client {
	private readonly socket: WebSocket;
	private nextId = 1;
	private readonly pending = new Map<number, PendingResponse>();
	private readonly notifications: WireRecord[] = [];
	private readonly waiters = new Set<NotificationWaiter>();

	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
		socket.on("error", (error) => this.rejectAll(error));
	}

	mark(): number {
		return this.notifications.length;
	}

	notificationsSince(mark: number): readonly WireRecord[] {
		return this.notifications.slice(mark);
	}

	request(method: string, params: unknown): Promise<WireRecord> {
		const id = this.nextId;
		this.nextId += 1;
		return new Promise((resolveResponse, rejectResponse) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				rejectResponse(new Error(`${method} timed out`));
			}, 30_000);
			this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timeout });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	waitForNotification(predicate: (notification: WireRecord) => boolean): Promise<WireRecord> {
		const existing = this.notifications.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolveNotification, rejectNotification) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(waiter);
				rejectNotification(new Error("notification timed out"));
			}, 120_000);
			const waiter: NotificationWaiter = {
				predicate,
				resolve: resolveNotification,
				reject: rejectNotification,
				timeout,
			};
			this.waiters.add(waiter);
		});
	}

	async close(): Promise<void> {
		if (this.socket.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolveClose) => {
			this.socket.once("close", () => resolveClose());
			this.socket.close();
		});
	}

	private handleMessage(data: RawData, isBinary: boolean): void {
		if (isBinary) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString("utf8"));
		} catch (error: unknown) {
			if (error instanceof Error) this.rejectAll(error);
			return;
		}
		if (!isRecord(parsed)) return;
		if (typeof parsed.id === "number") {
			const pending = this.pending.get(parsed.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.pending.delete(parsed.id);
			pending.resolve(parsed);
			return;
		}
		if (typeof parsed.method !== "string") return;
		this.notifications.push(parsed);
		for (const waiter of this.waiters) {
			if (!waiter.predicate(parsed)) continue;
			clearTimeout(waiter.timeout);
			this.waiters.delete(waiter);
			waiter.resolve(parsed);
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timeout);
			waiter.reject(error);
		}
		this.waiters.clear();
	}
}

export async function connectTask24Client(port: number): Promise<Task24Client> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timeout = setTimeout(() => rejectOpen(new Error("websocket open timed out")), 10_000);
		socket.once("open", () => {
			clearTimeout(timeout);
			resolveOpen();
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			rejectOpen(error);
		});
	});
	return new Task24Client(socket);
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
