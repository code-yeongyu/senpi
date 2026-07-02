import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRegistry,
	type MethodRegistry,
	type RegistryConnection,
} from "../../src/modes/app-server/rpc/registry.ts";
import {
	NotificationRouter,
	type RoutableConnection,
	type RouterNotification,
} from "../../src/modes/app-server/server/notifications.ts";
import { registerThreadLifecycleHandlers } from "../../src/modes/app-server/threads/handlers.ts";
import { ThreadRegistry } from "../../src/modes/app-server/threads/registry.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";

export const roots: string[] = [];

export class FakeConnection implements RoutableConnection, RegistryConnection {
	readonly id: string;
	readonly transport = "ws";
	readonly received: RouterNotification[] = [];
	readonly capabilities = { experimentalApi: true };
	initialized = true;
	optOutNotificationMethods: readonly string[] | null = null;

	constructor(id = "conn-1") {
		this.id = id;
	}

	send(notification: RouterNotification): void {
		this.received.push(notification);
	}
}

export async function scratchRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-app-server-thread-handlers-"));
	roots.push(root);
	return root;
}

export async function cleanupRoots(): Promise<void> {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) {
			await rm(root, { recursive: true, force: true });
		}
	}
}

export async function createHarness(): Promise<{
	readonly connection: FakeConnection;
	readonly registry: MethodRegistry;
	readonly root: string;
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
}> {
	const root = await scratchRoot();
	return { root, ...createHarnessForRoot(root) };
}

export function createHarnessForRoot(root: string): {
	readonly connection: FakeConnection;
	readonly registry: MethodRegistry;
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
} {
	const connection = new FakeConnection();
	const threads = new ThreadRegistry({
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
	});
	const notifications = new NotificationRouter({ connections: [connection] });
	const registry = createRegistry();
	const turnLog = new TurnLog();
	registerThreadLifecycleHandlers(registry, {
		threads,
		turnLog,
		notifications,
		idleUnloadMinutes: 5,
	});
	return { connection, registry, threads, turnLog };
}

export async function writePersistedSession(root: string, threadId: string): Promise<void> {
	const sessionDir = join(root, "sessions");
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `2026-07-02T00-00-00-000Z_${threadId}.jsonl`);
	await writeFile(
		sessionFile,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: threadId,
				timestamp: "2026-07-02T00:00:00.000Z",
				cwd: root,
			}),
			"",
		].join("\n"),
	);
}

export function responseResult(response: Awaited<ReturnType<MethodRegistry["dispatch"]>>): Record<string, unknown> {
	if ("error" in response) {
		throw new Error(response.error.message);
	}
	return objectValue(response.result);
}

export function objectAt(value: unknown, key: string): Record<string, unknown> {
	const object = objectValue(value);
	return objectValue(object[key]);
}

export function stringAt(value: unknown, key: string): string {
	const object = objectValue(value);
	const child = object[key];
	if (typeof child !== "string") {
		throw new Error(`Expected ${key} to be a string`);
	}
	return child;
}

export function threadIdFromResponse(response: Awaited<ReturnType<MethodRegistry["dispatch"]>>): string {
	return stringAt(objectAt(responseResult(response), "thread"), "id");
}

export function threadIdsFromList(response: Awaited<ReturnType<MethodRegistry["dispatch"]>>): string[] {
	return dataArray(responseResult(response)).map((thread) => stringAt(thread, "id"));
}

export function dataArray(value: unknown, key = "data"): unknown[] {
	const object = objectValue(value);
	const child = object[key];
	if (!Array.isArray(child)) {
		throw new Error(`Expected ${key} to be an array`);
	}
	return child;
}

export function objectValue(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected an object");
	}
	return Object.fromEntries(Object.entries(value));
}
