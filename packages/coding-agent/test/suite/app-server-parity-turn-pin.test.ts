import { describe, expect, it } from "vitest";
import { createRegistry } from "../../src/modes/app-server/rpc/registry.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	createTurnEngine,
	type TurnEngineNotification,
	type TurnEngineSession,
	type TurnEngineStore,
} from "../../src/modes/app-server/threads/turns.ts";
import { turnStartParams } from "../../src/modes/app-server/turn-adapter.ts";
import { FakeConnection, numberAt, objectAt, responseResult, stringAt } from "./app-server-thread-handlers-harness.ts";

describe("app-server turn parity characterization pin", () => {
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
			const itemStartedParams = objectAt(notificationAt(notifications, 2, "item/started"), "params");
			const item = objectAt(itemStartedParams, "item");
			const itemId = stringAt(item, "id");
			const itemStartedAtMs = numberAt(itemStartedParams, "startedAtMs");
			const completedParams = objectAt(notificationAt(notifications, 5, "turn/completed"), "params");
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
				{
					method: "thread/status/changed",
					params: { threadId: entry.id, status: { type: "active", activeFlags: [] } },
				},
				{ method: "turn/started", params: { threadId: entry.id, turn: inProgressTurn } },
				{
					method: "item/started",
					params: { threadId: entry.id, turnId, item: userItem, startedAtMs: itemStartedAtMs },
				},
				{
					method: "item/completed",
					params: { threadId: entry.id, turnId, item: userItem, completedAtMs: itemStartedAtMs },
				},
				{ method: "thread/status/changed", params: { threadId: entry.id, status: { type: "idle" } } },
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
			]);
		} finally {
			engine.completeTurn(entry.id);
		}
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
