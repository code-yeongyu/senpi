import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { JsonValue } from "../../src/modes/app-server/protocol/index.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	createTurnEngine,
	type TurnEngineNotification,
	type TurnEngineSession,
	type TurnEngineSessionEvent,
	type TurnEngineStore,
} from "../../src/modes/app-server/threads/turns.ts";

describe("app-server failed turn terminal contract", () => {
	it("emits error before failed turn/completed when prompt preflight fails", async () => {
		// Given: a loaded thread whose prompt preflight rejects the turn.
		const session = createPreflightFailureSession();
		const entry = {
			id: "failure-thread",
			cwd: "/tmp/failure-thread",
			session,
			activeTurn: null,
			status: "idle" as const,
			updatedAt: "2026-07-20T00:00:00.000Z",
		};
		const store: TurnEngineStore = {
			getLoadedThread: () => entry,
			runThreadTask: (_threadId, task) => Promise.resolve().then(task),
		};
		const notifications: TurnEngineNotification[] = [];
		const engine = createTurnEngine({
			store,
			turnLog: new TurnLog(),
			emitToThread: (_threadId, notification) => notifications.push(notification),
			broadcast: (notification) => notifications.push(notification),
		});

		// When: turn/start reaches the failed preflight path.
		await expect(
			engine.startTurn({
				threadId: entry.id,
				input: [{ type: "text", text: "fail before prompt" }],
			}),
		).rejects.toThrow("Prompt preflight failed");

		// Then: HEAD's terminal error pair is emitted in order, with no invented turn/failed method.
		const methods = notifications.map((notification) => notification.method);
		expect(methods).toEqual([
			"thread/status/changed",
			"turn/started",
			"item/started",
			"item/completed",
			"thread/status/changed",
			"error",
			"turn/completed",
		]);
		expect(methods).not.toContain("turn/failed");
		const error = notifications[5];
		const completed = notifications[6];
		expect(error).toMatchObject({
			method: "error",
			params: {
				threadId: entry.id,
				error: {
					message: "Prompt preflight failed",
					codexErrorInfo: "other",
					additionalDetails: null,
				},
				willRetry: false,
			},
		});
		expect(completed).toMatchObject({
			method: "turn/completed",
			params: { threadId: entry.id, turn: { status: "failed", error: { message: "Prompt preflight failed" } } },
		});
	});

	it("emits exactly one matching error pair for a projected assistant failure", async () => {
		// Given: a running turn whose session can emit a real assistant stream error.
		const projected = createProjectedFailureSession();
		const entry = {
			id: "projected-failure-thread",
			cwd: "/tmp/projected-failure-thread",
			session: projected.session,
			activeTurn: null,
			status: "idle" as const,
			updatedAt: "2026-07-20T00:00:00.000Z",
		};
		const store: TurnEngineStore = {
			getLoadedThread: () => entry,
			runThreadTask: (_threadId, task) => Promise.resolve().then(task),
		};
		const notifications: TurnEngineNotification[] = [];
		const engine = createTurnEngine({
			store,
			turnLog: new TurnLog(),
			emitToThread: (_threadId, notification) => notifications.push(notification),
			broadcast: (notification) => notifications.push(notification),
		});
		await engine.startTurn({
			threadId: entry.id,
			input: [{ type: "text", text: "fail while streaming" }],
		});

		// When: the assistant stream reports a provider failure.
		const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" });
		projected.emit({
			type: "message_update",
			message: failure,
			assistantMessageEvent: { type: "error", reason: "error", error: failure },
		});

		// Then: one error precedes turn/completed and both carry the same turn id and error object.
		const errors = notifications.filter((notification) => notification.method === "error");
		const completed = notifications.find((notification) => notification.method === "turn/completed");
		expect(errors).toHaveLength(1);
		expect(completed).toBeDefined();
		const error = errors[0];
		const errorParams = jsonObject(error?.params);
		const completedParams = jsonObject(completed?.params);
		const completedTurn = jsonObject(completedParams.turn);
		expect(errorParams).toMatchObject({
			threadId: entry.id,
			willRetry: false,
			error: {
				message: "provider exploded",
				codexErrorInfo: "other",
				additionalDetails: null,
			},
		});
		expect(errorParams.turnId).toBe(completedTurn.id);
		expect(errorParams.error).toEqual(completedTurn.error);
		expect(notifications.indexOf(error)).toBeLessThan(
			completed === undefined ? -1 : notifications.indexOf(completed),
		);
	});
});

function createPreflightFailureSession(): TurnEngineSession {
	return {
		prompt: async (_text, options) => options?.preflightResult?.(false),
		steer: async () => undefined,
		abort: async () => undefined,
		subscribe: () => () => undefined,
	};
}

function createProjectedFailureSession(): {
	readonly session: TurnEngineSession;
	readonly emit: (event: AgentSessionEvent) => void;
} {
	let listener: ((event: TurnEngineSessionEvent) => void) | undefined;
	return {
		session: {
			prompt: async (_text, options) => options?.preflightResult?.(true),
			steer: async () => undefined,
			abort: async () => undefined,
			subscribe: (nextListener) => {
				listener = nextListener;
				return () => {
					listener = undefined;
				};
			},
		},
		emit: (event) => listener?.(event),
	};
}

function jsonObject(value: JsonValue | undefined): { readonly [key: string]: JsonValue | undefined } {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return Object.fromEntries(Object.entries(value));
	}
	throw new Error("expected JSON object");
}
