import { describe, expect, it } from "vitest";
import { UnknownCommandError } from "../../src/core/unknown-command.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import {
	createTurnEngine,
	TurnEngineError,
	type TurnEngineNotification,
	type TurnEngineSession,
	type TurnEngineStore,
} from "../../src/modes/app-server/threads/turns.ts";

type PromptOptions = Parameters<TurnEngineSession["prompt"]>[1];

function createHarness(prompt: TurnEngineSession["prompt"]) {
	const entry = {
		id: "unknown-command-thread",
		cwd: "/tmp/unknown-command-thread",
		session: {
			prompt,
			steer: async () => undefined,
			abort: async () => undefined,
			subscribe: () => () => undefined,
		} satisfies TurnEngineSession,
		activeTurn: null as { readonly turnId: string; readonly startedAt: string } | null,
		status: "idle" as "idle" | "active",
		updatedAt: "2026-09-29T00:00:00.000Z",
	};
	const store: TurnEngineStore = {
		getLoadedThread: () => entry,
		runThreadTask: (_threadId, task) => Promise.resolve().then(task),
	};
	const notifications: TurnEngineNotification[] = [];
	const turnLog = new TurnLog();
	const engine = createTurnEngine({
		store,
		turnLog,
		emitToThread: (_threadId, notification) => notifications.push(notification),
		broadcast: (notification) => notifications.push(notification),
	});
	// Mirrors the runtime's deferForResponse: announcements wait until the turn/start response is sent.
	const deferred: Array<() => void> = [];
	const startTurn = async (params: { readonly text: string; readonly unknownCommandAsText?: boolean }) => {
		try {
			return await engine.startTurn(
				{
					threadId: entry.id,
					input: [{ type: "text", text: params.text }],
					...(params.unknownCommandAsText ? { unknownCommandAsText: true } : {}),
				},
				(action) => {
					deferred.push(action);
					return true;
				},
			);
		} finally {
			for (const action of deferred.splice(0)) action();
		}
	};
	return { entry, notifications, turnLog, startTurn };
}

describe("app-server turn/start for an unknown command", () => {
	it("refuses with structured unknown_command data and never announces a turn", async () => {
		const harness = createHarness(async (_text, options) => {
			options?.preflightResult?.(false);
			throw new UnknownCommandError("foo", ["favorite-models"], "unknown");
		});

		const refusal = await harness.startTurn({ text: "/foo bar" }).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(TurnEngineError);
		expect(refusal instanceof TurnEngineError ? refusal.error : undefined).toMatchObject({
			code: -32602,
			data: { errorCode: "unknown_command", command: "foo", suggestions: ["favorite-models"], reason: "unknown" },
		});
		expect(harness.notifications).toEqual([]);
		expect(harness.turnLog.readTurns(harness.entry.id)).toEqual([]);
		expect(harness.entry).toMatchObject({ activeTurn: null, status: "idle" });
	});

	it("forwards unknownCommandAsText to the session prompt", async () => {
		const seen: PromptOptions[] = [];
		const harness = createHarness(async (_text, options) => {
			seen.push(options);
			options?.preflightResult?.(true);
		});

		await harness.startTurn({ text: "/foo bar", unknownCommandAsText: true });

		expect(seen[0]?.unknownCommandAsText).toBe(true);
		expect(harness.notifications.map((notification) => notification.method)).toContain("turn/started");
	});
});
