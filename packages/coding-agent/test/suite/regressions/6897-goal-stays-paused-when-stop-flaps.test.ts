import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type GoalTool = Pick<ToolDefinition, "name" | "execute">;
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

const T0 = Date.UTC(2026, 10, 17, 14, 0, 0);
const stopHold: SessionHoldRecord = { kind: "session_hold", key: "session_hold:1", data: { localSeq: 1 } };
const dirs: string[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(T0);
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function goalSession() {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-6897-"));
	dirs.push(dir);
	const tools = new Map<string, GoalTool>();
	const handlers = new Map<string, Handler[]>();
	const entries: SessionEntry[] = [];
	const statuses: Array<string | undefined> = [];
	let holds: SessionHoldRecord[] = [];
	const pi = {
		registerTool: (tool: GoalTool) => tools.set(tool.name, tool),
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
			getSessionId: () => "thread-6897",
			getBranch: () => [],
			getEntries: () => entries,
			reduceHistory: <S>(reducer: HistoryReducer<S>) => entries.reduce(reducer.add, reducer.initial()),
		},
	} as unknown as ExtensionContext;
	// The runner hands each edge to the handler as it is emitted; the handler's work is not awaited before the next edge.
	const edge = (change: "paused" | "resumed", next: SessionHoldRecord[]) => {
		holds = next;
		return Promise.all(
			(handlers.get("session_hold_changed") ?? []).map((handler) =>
				handler({ type: "session_hold_changed", change, pauseSeq: 1, holds }, ctx),
			),
		);
	};
	await tools
		.get("create_goal")
		?.execute("c1", { objective: "Ship it" }, undefined, undefined, ctx as ExtensionToolContext);
	return {
		storeRef: { baseDir: join(dir, "extensions", "goal"), threadId: "thread-6897" },
		edge,
		lastStatus: () => statuses.at(-1),
	};
}

describe("senpi#6897: an input that releases a Stop and takes it back leaves the goal paused", () => {
	it("keeps the goal paused and its elapsed time frozen when a command flaps the Stop hold", async () => {
		const session = await goalSession();
		vi.advanceTimersByTime(120_000);
		await session.edge("paused", [stopHold]);
		expect(session.lastStatus()).toBe("Goal paused (/goal resume)");

		// A slash command typed under the Stop: input releases the hold, admits no turn, and the hold comes back
		// before the goal finished handling the release (the live session file showed 21 ms between the two).
		const released = session.edge("resumed", []);
		const retaken = session.edge("paused", [stopHold]);
		await Promise.all([released, retaken]);

		expect(await readGoal(session.storeRef)).toMatchObject({ status: "paused", timeUsedSeconds: 120 });
		expect(session.lastStatus()).toBe("Goal paused (/goal resume)");

		vi.advanceTimersByTime(600_000);
		expect(session.lastStatus()).toBe("Goal paused (/goal resume)");
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "paused", timeUsedSeconds: 120 });

		// A real release (a message that starts a turn) still resumes from the frozen value.
		await session.edge("resumed", []);
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "active", timeUsedSeconds: 120 });
		expect(session.lastStatus()).toBe("Pursuing goal (2m)");
	});
});
