import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function goalSession(threadId: string) {
	const dir = await mkdtemp(join(tmpdir(), "senpi-3811-goal-"));
	dirs.push(dir);
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, Handler[]>();
	const entries: SessionEntry[] = [];
	let holds: SessionHoldRecord[] = [];
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
		hasUI: false,
		cwd: dir,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: () => {}, select: async () => undefined, setStatus: () => {} },
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
	await tools
		.get("create_goal")
		?.execute("c1", { objective: "Ship it" }, undefined, undefined, ctx as ExtensionToolContext);
	return {
		storeRef,
		fire,
		setHolds: (next: SessionHoldRecord[]) => {
			holds = next;
		},
	};
}

const abortedTurn = {
	type: "agent_end",
	messages: [fauxAssistantMessage("", { stopReason: "aborted" })],
	aborted: true,
	abortSource: "user",
	willRetry: false,
};
const settledTurn = { type: "agent_end", messages: [fauxAssistantMessage("done")], willRetry: false };

describe("senpi#3811 a user Stop pauses the goal with the session", () => {
	it("pauses the goal on a Stop and reactivates it once the Stop is released", async () => {
		const session = await goalSession("thread-stop");
		session.setHolds([{ kind: "session_hold", key: "session_hold" }]);
		await session.fire("agent_start", { type: "agent_start" });
		await session.fire("agent_end", abortedTurn);
		expect(await readGoal(session.storeRef)).toMatchObject({ status: "paused" });

		session.setHolds([]);
		await session.fire("agent_start", { type: "agent_start" });
		await session.fire("agent_end", settledTurn);

		expect(await readGoal(session.storeRef)).toMatchObject({ status: "active" });
	});

	it("keeps blocking the goal on a plain interrupt with no Stop", async () => {
		const session = await goalSession("thread-plain");
		await session.fire("agent_start", { type: "agent_start" });
		await session.fire("agent_end", abortedTurn);

		expect(await readGoal(session.storeRef)).toMatchObject({
			status: "blocked",
			blockedReason: "user interrupted the turn",
		});
	});
});
