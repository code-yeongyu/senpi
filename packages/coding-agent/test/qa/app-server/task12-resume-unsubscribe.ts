import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcEnvelope } from "../../../src/modes/app-server/rpc/envelope.ts";
import { createRegistry } from "../../../src/modes/app-server/rpc/registry.ts";
import {
	NotificationRouter,
	type RoutableConnection,
	type RouterNotification,
} from "../../../src/modes/app-server/server/notifications.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";
import { registerThreadLifecycleHandlers } from "../../../src/modes/app-server/threads/handlers.ts";
import { ThreadRegistry } from "../../../src/modes/app-server/threads/registry.ts";
import { TurnLog } from "../../../src/modes/app-server/threads/turn-log.ts";

const scratchRoot = join(tmpdir(), `senpi-qa-task12-resume-unsubscribe-${process.pid}`);

async function main(): Promise<void> {
	rmSync(scratchRoot, { recursive: true, force: true });
	const sent = new Map<string, RpcEnvelope[]>();
	let runError: unknown;
	try {
		const registry = createRegistry();
		const core = new ServerCore({ registry, codexHome: join(scratchRoot, "agent"), version: "qa" });
		const connectionA = core.addConnection({
			id: "A",
			transportKind: "websocket",
			send: (message) => record(sent, "A", message),
			close: () => undefined,
		});
		const connectionB = core.addConnection({
			id: "B",
			transportKind: "websocket",
			send: (message) => record(sent, "B", message),
			close: () => undefined,
		});
		const notifications = new NotificationRouter({
			connections: [routerConnection(connectionA), routerConnection(connectionB)],
		});
		registerThreadLifecycleHandlers(registry, {
			threads: new ThreadRegistry({
				agentDir: join(scratchRoot, "agent"),
				sessionDir: join(scratchRoot, "sessions"),
			}),
			turnLog: new TurnLog(),
			notifications,
			idleUnloadMinutes: 10,
		});

		await initialize(core, "A", 1);
		await initialize(core, "B", 2);
		const started = await request(core, sent, "A", 3, "thread/start", { cwd: scratchRoot });
		const threadId = readThreadId(started);
		const resumed = await request(core, sent, "B", 4, "thread/resume", { threadId });
		const resumeKeys = Object.keys(objectAt(responseResult(resumed), "thread"))
			.sort()
			.join(",");
		const firstUnsubscribe = await request(core, sent, "B", 5, "thread/unsubscribe", { threadId });
		const secondUnsubscribe = await request(core, sent, "B", 6, "thread/unsubscribe", { threadId });
		const unsubscribeStatus = `${statusFrom(firstUnsubscribe)},${statusFrom(secondUnsubscribe)}`;
		console.log(`RESUME_KEYS=${resumeKeys}`);
		console.log(`UNSUB=${unsubscribeStatus}`);
		if (unsubscribeStatus !== "unsubscribed,notSubscribed") {
			throw new Error(`unexpected unsubscribe statuses: ${unsubscribeStatus}`);
		}
	} catch (error) {
		if (error instanceof Error) {
			runError = error;
		} else {
			throw error;
		}
	}
	rmSync(scratchRoot, { recursive: true, force: true });
	if (existsSync(scratchRoot)) {
		throw new Error(`cleanup failed: ${scratchRoot}`);
	}
	console.log(`CLEANUP=removed:${scratchRoot}`);
	if (runError) {
		throw runError;
	}
}

function record(sent: Map<string, RpcEnvelope[]>, connectionId: string, message: RpcEnvelope): void {
	const messages = sent.get(connectionId) ?? [];
	messages.push(message);
	sent.set(connectionId, messages);
}

function routerConnection(connection: ReturnType<ServerCore["addConnection"]>): RoutableConnection {
	return {
		id: connection.id,
		transport: "ws",
		get initialized() {
			return connection.initialized;
		},
		get capabilities() {
			return connection.capabilities;
		},
		get optOutNotificationMethods() {
			return [...connection.optOutNotificationMethods];
		},
		send(notification: RouterNotification) {
			return connection.send(notification);
		},
		close(reason) {
			void connection.close(reason);
		},
	};
}

async function initialize(core: ServerCore, connectionId: string, id: number): Promise<void> {
	await core.receive(connectionId, {
		kind: "request",
		message: {
			id,
			method: "initialize",
			params: { clientInfo: { name: `qa-${connectionId}`, version: "1.0.0" } },
		},
	});
	await core.receive(connectionId, { kind: "notification", message: { method: "initialized", params: {} } });
}

async function request(
	core: ServerCore,
	sent: Map<string, RpcEnvelope[]>,
	connectionId: string,
	id: number,
	method: string,
	params: Record<string, unknown>,
): Promise<RpcEnvelope> {
	const before = sent.get(connectionId)?.length ?? 0;
	await core.receive(connectionId, { kind: "request", message: { id, method, params } });
	const message = sent
		.get(connectionId)
		?.slice(before)
		.find((candidate) => {
			const envelope = objectValue(candidate);
			return envelope.id === id;
		});
	if (!message) {
		throw new Error(`missing response for ${method}`);
	}
	return message;
}

function statusFrom(response: RpcEnvelope): string {
	const status = responseResult(response).status;
	if (typeof status !== "string") {
		throw new Error("missing unsubscribe status");
	}
	return status;
}

function readThreadId(response: RpcEnvelope): string {
	return stringAt(objectAt(responseResult(response), "thread"), "id");
}

function responseResult(response: RpcEnvelope): Record<string, unknown> {
	const envelope = objectValue(response);
	if (envelope.error !== undefined) {
		const error = objectValue(envelope.error);
		throw new Error(typeof error.message === "string" ? error.message : "unknown error");
	}
	return objectValue(envelope.result);
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
	const object = objectValue(value);
	return objectValue(object[key]);
}

function stringAt(value: unknown, key: string): string {
	const object = objectValue(value);
	const child = object[key];
	if (typeof child !== "string") {
		throw new Error(`expected ${key} string`);
	}
	return child;
}

function objectValue(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected object");
	}
	return Object.fromEntries(Object.entries(value));
}

await main();
