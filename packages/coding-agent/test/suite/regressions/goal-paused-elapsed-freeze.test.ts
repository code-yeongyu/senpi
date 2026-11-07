import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	SessionHoldRecord,
	ToolDefinition,
} from "../../../src/core/extensions/types.ts";
import type { HistoryReducer } from "../../../src/core/session-history-reduce.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";

type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

const T0 = Date.UTC(2026, 10, 6, 3, 0, 0);
const dirs: string[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(T0);
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function heldGoalSession(threadId: string, options: { initialHolds?: SessionHoldRecord[]; dir?: string } = {}) {
	const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "senpi-goal-paused-elapsed-")));
	if (options.dir === undefined) dirs.push(dir);
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, Handler[]>();
	const entries: SessionEntry[] = [];
	const statuses: Array<string | undefined> = [];
	let holds = options.initialHolds ?? [];
	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `e${entries.length}`,
				parentId: null,
				timestamp: "",
				customType,
				data,
			} as SessionEntry);
		},
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	const ctx = {
		hasUI: true,
		cwd: dir,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			notify: () => {},
			select: async () => undefined,
			setStatus: (key: string, text: string | undefined) => {
				if (key === "goal") statuses.push(text);
			},
		},
		getPauseState: () => ({ pauseSeq: holds.length, holds }),
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => threadId,
			getBranch: () => [],
			getEntries: () => entries,
			reduceHistory: <S>(reducer: HistoryReducer<S>) => entries.reduce(reducer.add, reducer.initial()),
		},
	} as unknown as ExtensionContext;
	const fire = async (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const storeRef = { baseDir: join(dir, "extensions", "goal"), threadId };
	const createGoal = () =>
		tools
			.get("create_goal")
			?.execute("c1", { objective: "Ship it" }, undefined, undefined, ctx as ExtensionToolContext);
	const pauseWith = async (next: SessionHoldRecord[]) => {
		holds = next;
		await fire("session_hold_changed", { type: "session_hold_changed", change: "paused", pauseSeq: 1, holds });
	};
	const resume = async () => {
		holds = [];
		await fire("session_hold_changed", { type: "session_hold_changed", change: "resumed", pauseSeq: 1, holds });
	};
	return { dir, storeRef, fire, statuses, createGoal, pauseWith, resume, lastStatus: () => statuses.at(-1) };
}

const settledTurn = { type: "agent_end", messages: [fauxAssistantMessage("done")], willRetry: false };
const stopHold: SessionHoldRecord = { kind: "session_hold", key: "session_hold:1", data: { localSeq: 1 } };

describe("a paused goal's elapsed counter freezes (Q 2026-11-06: 'paused, yet the minute counter keeps rising')", () => {
	it("an idle Stop shows the goal paused, freezes elapsed time, and resumes from the frozen value", async () => {
		const session = await heldGoalSession("thread-idle-stop");
		await session.createGoal();
		vi.advanceTimersByTime(120_000);
		expect(session.lastStatus()).toBe("Pursuing goal (2m)");

		await session.pauseWith([stopHold]);
		const pausedFrom = session.statuses.length - 1;
		expect(session.lastStatus()).toBe("Goal paused (/goal resume)");
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "paused", timeUsedSeconds: 120 });

		vi.advanceTimersByTime(600_000);
		expect(session.lastStatus()).toBe("Goal paused (/goal resume)");
		expect(new Set(session.statuses.slice(pausedFrom))).toEqual(new Set(["Goal paused (/goal resume)"]));
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "paused", timeUsedSeconds: 120 });

		await session.resume();
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "active", timeUsedSeconds: 120 });
		expect(session.lastStatus()).toBe("Pursuing goal (2m)");

		vi.advanceTimersByTime(60_000);
		expect(session.lastStatus()).toBe("Pursuing goal (3m)");
		await session.fire("agent_start", { type: "agent_start" });
		await session.fire("agent_end", settledTurn);
		// Only active time counts: 120 s before the Stop plus 60 s after the resume, never the 600 s held.
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "active", timeUsedSeconds: 180 });
		await session.fire("session_shutdown", { type: "session_shutdown" });
	});

	it("a Stop that lands during a turn the turn does not abort pauses the goal at agent_end", async () => {
		const session = await heldGoalSession("thread-boundary-stop");
		await session.createGoal();
		await session.fire("agent_start", { type: "agent_start" });
		vi.advanceTimersByTime(20_000);
		await session.pauseWith([stopHold]);
		await session.fire("agent_end", settledTurn);
		vi.advanceTimersByTime(600_000);

		expect(session.lastStatus()).toBe("Goal paused (/goal resume)");
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "paused", timeUsedSeconds: 20 });
		await session.fire("session_shutdown", { type: "session_shutdown" });
	});

	it("a parent's inherited hold pauses a child's goal the same way", async () => {
		const session = await heldGoalSession("thread-inherited");
		await session.createGoal();
		vi.advanceTimersByTime(30_000);
		await session.pauseWith([{ kind: "inherited_hold", key: "inherited_hold" }]);
		vi.advanceTimersByTime(3_600_000);

		expect(session.lastStatus()).toBe("Goal paused (/goal resume)");
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "paused", timeUsedSeconds: 30 });
		await session.fire("session_shutdown", { type: "session_shutdown" });
	});

	it("an unattended or interrupted-run hold does not pause the goal", async () => {
		const session = await heldGoalSession("thread-unattended");
		await session.createGoal();
		await session.pauseWith([
			{ kind: "unattended", key: "unattended" },
			{ kind: "session_hold", key: "interrupted-run" },
		]);
		vi.advanceTimersByTime(60_000);

		expect(session.lastStatus()).toBe("Pursuing goal (1m)");
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "active" });
		await session.fire("session_shutdown", { type: "session_shutdown" });
	});

	it("a session reopened under a live Stop starts with the goal paused and its counter frozen", async () => {
		const first = await heldGoalSession("thread-reopen");
		await first.createGoal();
		vi.advanceTimersByTime(45_000);
		await first.fire("session_shutdown", { type: "session_shutdown" });

		const reopened = await heldGoalSession("thread-reopen", { initialHolds: [stopHold], dir: first.dir });
		await reopened.fire("session_start", { type: "session_start", reason: "resume" });
		vi.advanceTimersByTime(600_000);

		expect(reopened.lastStatus()).toBe("Goal paused (/goal resume)");
		expect(await readGoal(reopened.storeRef)).toMatchObject({ status: "paused", timeUsedSeconds: 45 });
		await reopened.fire("session_shutdown", { type: "session_shutdown" });
	});
});
