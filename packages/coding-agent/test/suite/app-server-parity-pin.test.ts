import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../src/config.ts";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import {
	createRegistry,
	type MethodRegistration,
	type MethodRegistry,
} from "../../src/modes/app-server/rpc/registry.ts";
import { NotificationRouter, type RoutableThread } from "../../src/modes/app-server/server/notifications.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";
import { registerThreadLifecycleHandlers } from "../../src/modes/app-server/threads/handlers.ts";
import { ThreadRegistry } from "../../src/modes/app-server/threads/registry.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	createTurnEngine,
	type TurnEngineNotification,
	type TurnEngineSession,
	type TurnEngineStore,
} from "../../src/modes/app-server/threads/turns.ts";
import { turnStartParams } from "../../src/modes/app-server/turn-adapter.ts";
import {
	cleanupRoots,
	FakeConnection,
	objectAt,
	objectValue,
	responseResult,
	scratchRoot,
	stringAt,
} from "./app-server-thread-handlers-harness.ts";

type MethodGroups = Readonly<Record<"stable" | "experimental", readonly string[]>>;

type CapabilityManifest = {
	readonly gates: { readonly experimentalApi: readonly string[] };
	readonly out: MethodGroups;
};

const manifestPath = join(process.cwd(), "test/qa/app-server/capability-manifest.json");

afterEach(async () => {
	await cleanupRoots();
});

describe("app-server parity characterization pins", () => {
	it("pins legacy thread registrations and response shapes", async () => {
		const mutation = process.env.SENPI_APP_SERVER_PIN_MUTATION;
		const harness = await createLifecycleHarness(mutation === "legacy-registration" ? "thread/start" : undefined);
		try {
			const started = await harness.registry.dispatch(harness.connection, {
				id: 1,
				method: "thread/start",
				params: { cwd: harness.root },
			});
			const startedResult = responseResult(started);
			const startedThread = objectAt(startedResult, "thread");
			const threadId = stringAt(startedThread, "id");
			const createdAt = numberAt(startedThread, "createdAt");
			const sessionPath = stringAt(startedThread, "path");
			const expectedThread = {
				id: threadId,
				sessionId: threadId,
				forkedFromId: null,
				parentThreadId: null,
				preview: "",
				ephemeral: false,
				modelProvider: "unknown",
				createdAt,
				updatedAt: createdAt,
				recencyAt: createdAt,
				status: { type: "idle" },
				path: sessionPath,
				cwd: harness.root,
				cliVersion: VERSION,
				source: "appServer",
				threadSource: null,
				agentNickname: null,
				agentRole: null,
				gitInfo: null,
				name: null,
				turns: [],
			};
			const startedForAssertion = mutation === "legacy-shape" ? { ...started, unexpected: true } : started;
			expect(startedForAssertion).toEqual({
				id: 1,
				result: {
					thread: expectedThread,
					model: "unknown",
					modelProvider: "unknown",
					serviceTier: null,
					cwd: harness.root,
					runtimeWorkspaceRoots: [harness.root],
					instructionSources: [],
					approvalPolicy: "never",
					approvalsReviewer: "user",
					sandbox: { type: "dangerFullAccess" },
					activePermissionProfile: null,
					reasoningEffort: "off",
					multiAgentMode: "explicitRequestOnly",
				},
			});

			const read = await harness.registry.dispatch(harness.connection, {
				id: 2,
				method: "thread/read",
				params: { threadId, includeTurns: true },
			});
			expect(read).toEqual({ id: 2, result: { thread: expectedThread } });

			const listed = await harness.registry.dispatch(harness.connection, {
				id: 3,
				method: "thread/list",
				params: { limit: 25 },
			});
			expect(listed).toEqual({
				id: 3,
				result: { data: [expectedThread], nextCursor: null, backwardsCursor: null },
			});
		} finally {
			harness.lifecycle.dispose();
		}
	});

	it("pins the scripted turn/start to turn/completed flow", async () => {
		const mutation = process.env.SENPI_APP_SERVER_PIN_MUTATION;
		const session = createPinSession();
		const entry = {
			id: "pin-thread",
			cwd: "/tmp/pin-thread",
			session,
			activeTurn: null,
			status: "idle" as const,
			updatedAt: "2026-07-19T00:00:00.000Z",
		};
		const store: TurnEngineStore = {
			getLoadedThread: (threadId) => {
				if (threadId !== entry.id) throw new Error(`unknown thread ${threadId}`);
				return entry;
			},
			runThreadTask: (_threadId, task) => Promise.resolve().then(task),
		};
		const notifications: TurnEngineNotification[] = [];
		const engine = createTurnEngine({
			store,
			turnLog: new TurnLog(),
			emitToThread: (_threadId, notification) => notifications.push(notification),
			broadcast: (notification) => notifications.push(notification),
		});
		const registry = createRegistry();
		if (mutation !== "turn-registration") {
			registry.register("turn/start", {
				scope: "thread",
				handler: ({ request }) => engine.startTurn(turnStartParams(request)),
			});
		}

		try {
			const response = await registry.dispatch(new FakeConnection("turn-pin"), {
				id: 4,
				method: "turn/start",
				params: { threadId: entry.id, input: [{ type: "text", text: "pin this turn" }] },
			});
			const responseTurn = objectAt(responseResult(response), "turn");
			const turnId = stringAt(responseTurn, "id");
			const startedAt = numberAt(responseTurn, "startedAt");
			const inProgressTurn = {
				id: turnId,
				items: [],
				itemsView: "full",
				status: "inProgress",
				error: null,
				startedAt,
				completedAt: null,
				durationMs: null,
			};
			const responseForAssertion = mutation === "turn-shape" ? { ...response, unexpected: true } : response;
			expect(responseForAssertion).toEqual({ id: 4, result: { turn: inProgressTurn } });
			if (mutation !== "turn-terminal") session.emitAgentEnd();
			const itemStartedParams = objectAt(notificationAt(notifications, 1, "item/started"), "params");
			const item = objectAt(itemStartedParams, "item");
			const itemId = stringAt(item, "id");
			const itemStartedAtMs = numberAt(itemStartedParams, "startedAtMs");
			const completedParams = objectAt(notificationAt(notifications, 3, "turn/completed"), "params");
			const completedTurn = objectAt(completedParams, "turn");
			const completedAt = numberAt(completedTurn, "completedAt");
			const durationMs = numberAt(completedTurn, "durationMs");
			const userItem = {
				type: "userMessage",
				id: itemId,
				clientId: null,
				content: [{ type: "text", text: "pin this turn", text_elements: [] }],
			};
			expect(notifications).toEqual([
				{ method: "turn/started", params: { threadId: entry.id, turn: inProgressTurn } },
				{
					method: "item/started",
					params: { threadId: entry.id, turnId, item: userItem, startedAtMs: itemStartedAtMs },
				},
				{
					method: "item/completed",
					params: { threadId: entry.id, turnId, item: userItem, completedAtMs: itemStartedAtMs },
				},
				{
					method: "turn/completed",
					params: {
						threadId: entry.id,
						turn: {
							...inProgressTurn,
							items: [userItem],
							status: "completed",
							completedAt,
							durationMs,
						},
					},
				},
				{ method: "thread/status/changed", params: { threadId: entry.id, status: { type: "idle" } } },
			]);
		} finally {
			engine.completeTurn(entry.id);
		}
	});

	it("returns -32601 for every manifest OUT method", async () => {
		const manifest = readManifest();
		const registry = createRegistry();
		const firstOut = manifest.out.stable[0];
		if (process.env.SENPI_APP_SERVER_PIN_MUTATION === "out-method" && firstOut !== undefined) {
			registry.register(firstOut, { handler: () => ({}) });
		}
		const sent: RpcEnvelope[] = [];
		const core = new ServerCore({ registry, codexHome: "/tmp/senpi-parity-pin" });
		const connectionId = addCoreConnection(core, "out-pin", sent);
		await initialize(core, connectionId, true);
		for (const [index, method] of [...manifest.out.stable, ...manifest.out.experimental].entries()) {
			await core.receive(connectionId, { kind: "request", message: { id: index + 10, method, params: {} } });
			const response = sent.at(-1);
			expect(response).toEqual({ id: index + 10, error: { code: -32601, message: `Method not found: ${method}` } });
		}
	});

	it("enforces each manifest experimentalApi gate", async () => {
		const manifest = readManifest();
		expect(manifest.gates.experimentalApi).toContain("thread/searchOccurrences");
		const sent: RpcEnvelope[] = [];
		const core = new ServerCore({ codexHome: "/tmp/senpi-parity-pin" });
		for (const method of ["thread/search", "thread/searchOccurrences", "thread/turns/list", "thread/items/list"]) {
			if (manifest.gates.experimentalApi.includes(method)) {
				core.registerMethod(method, { experimental: true, handler: () => ({}) });
			}
		}
		const connectionId = addCoreConnection(core, "gate-pin", sent);
		const mutation = process.env.SENPI_APP_SERVER_PIN_MUTATION;
		await initialize(core, connectionId, mutation === "experimental-gate");
		for (const [index, method] of manifest.gates.experimentalApi.entries()) {
			await core.receive(connectionId, { kind: "request", message: { id: index + 20, method, params: {} } });
			expect(sent.at(-1)).toEqual({
				id: index + 20,
				error: { code: -32600, message: `${method} requires experimentalApi capability` },
			});
		}
	});

	it("replays terminal notifications FIFO and keeps routing scoped", () => {
		const entry: RoutableThread = { id: "pin-thread", subscribers: new Set(), queuedTerminalNotifications: [] };
		const connection = new FakeConnection("queue-pin");
		const router = new NotificationRouter({ connections: [connection], threads: [entry] });
		router.toThread("pin-thread", { method: "turn/completed", params: { turnId: "turn-1" } });
		router.toThread("pin-thread", { method: "error", params: { turnId: "turn-2" } });
		router.toThread("pin-thread", { method: "turn/failed", params: { turnId: "retired-turn" } });
		if (process.env.SENPI_APP_SERVER_PIN_MUTATION === "terminal-queue") {
			entry.queuedTerminalNotifications.reverse();
		}
		router.subscribe("pin-thread", connection.id);
		router.toThread("pin-thread", { method: "turn/started", params: { turnId: "turn-3" } });
		expect(connection.received.map((notification) => notification.method)).toEqual([
			"turn/completed",
			"error",
			"turn/started",
		]);
		expect(entry.queuedTerminalNotifications).toEqual([]);
	});

	it("keeps broadcast notifications global and turn notifications thread-scoped", () => {
		const entry: RoutableThread = {
			id: "pin-thread",
			subscribers: new Set(["pin-a"]),
			queuedTerminalNotifications: [],
		};
		const first = new FakeConnection("pin-a");
		const second = new FakeConnection("pin-b");
		const router = new NotificationRouter({ connections: [first, second], threads: [entry] });
		router.broadcast({ method: "thread/started", params: { threadId: entry.id } });
		if (process.env.SENPI_APP_SERVER_PIN_MUTATION === "routing") entry.subscribers.add(second.id);
		router.toThread(entry.id, { method: "turn/started", params: { threadId: entry.id } });
		expect(first.received.map((notification) => notification.method)).toEqual(["thread/started", "turn/started"]);
		expect(second.received.map((notification) => notification.method)).toEqual(["thread/started"]);
		expect(() => router.broadcast({ method: "turn/started", params: { threadId: entry.id } })).toThrow(
			/not allowed for broadcast/,
		);
	});
});

type PinSession = TurnEngineSession & { emitAgentEnd(): void };

function createPinSession(): PinSession {
	const listeners = new Set<(event: { readonly type: string }) => void>();
	const emitAgentEnd = (): void => listeners.forEach((listener) => void listener({ type: "agent_end" }));
	return {
		prompt: async (_text, options) => {
			options?.preflightResult?.(true);
		},
		steer: async () => undefined,
		abort: async () => emitAgentEnd(),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emitAgentEnd,
	};
}

async function createLifecycleHarness(dropMethod: string | undefined) {
	const root = await scratchRoot();
	const connection = new FakeConnection("lifecycle-pin");
	const threads = new ThreadRegistry({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") });
	const notifications = new NotificationRouter({ connections: [connection] });
	const base = createRegistry();
	const registry: MethodRegistry = {
		register(method: string, registration: MethodRegistration): void {
			if (method !== dropMethod) base.register(method, registration);
		},
		dispatch: (currentConnection, request) => base.dispatch(currentConnection, request),
	};
	const lifecycle = registerThreadLifecycleHandlers(registry, { threads, turnLog: new TurnLog(), notifications });
	return { root, connection, registry, lifecycle };
}

async function initialize(core: ServerCore, connectionId: string, experimentalApi: boolean): Promise<void> {
	await core.receive(connectionId, {
		kind: "request",
		message: {
			id: 1,
			method: "initialize",
			params: {
				clientInfo: { name: "parity-pin", title: "Parity Pin", version: "0.0.1" },
				capabilities: { experimentalApi, requestAttestation: false },
			},
		},
	});
}

function addCoreConnection(core: ServerCore, id: string, sent: RpcEnvelope[]): string {
	return core.addConnection({
		id,
		transportKind: "stdio",
		send: (message) => void sent.push(message),
		close: () => undefined,
	}).id;
}

function numberAt(value: unknown, key: string): number {
	const child = objectValue(value)[key];
	if (typeof child !== "number") {
		throw new Error(`Expected ${key} to be a number`);
	}
	return child;
}

function notificationAt(
	notifications: readonly TurnEngineNotification[],
	index: number,
	method: TurnEngineNotification["method"],
): TurnEngineNotification {
	const notification = notifications[index];
	if (notification === undefined) {
		throw new Error(`Missing notification ${method} at index ${index}`);
	}
	expect(notification.method).toBe(method);
	return notification;
}

function readManifest(): CapabilityManifest {
	return JSON.parse(readFileSync(manifestPath, "utf8"));
}
