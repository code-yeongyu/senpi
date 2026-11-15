// senpi#5898: a hosted loop's interceptors run the user's handlers on the hand, and the result the loop gets back is the
// one a local session's emit merges from the same extension (C8: the loop waits for it).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createLoopHookCall } from "../../src/modes/rpc/loop-hook-call.ts";
import { extensionLoopHooks } from "../../src/modes/rpc/loopless-loop-hooks.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { localRunner, type LoopReply, loopEventMachine, MODEL, PREVIOUS_MODEL, toJson } from "./loop-event-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

let user: Awaited<ReturnType<typeof loopEventMachine>>;
let local: ExtensionRunner;
beforeAll(async () => {
	user = await loopEventMachine();
	local = await localRunner(user.dirs.cwd);
});
afterAll(cleanupHands);

const note = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });
const message = fauxAssistantMessage("done");
const preview = { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [note("queued")] };
const entry = { type: "custom", id: "entry-2", parentId: "entry-1", timestamp: new Date(0).toISOString() };
const preparation = {
	targetId: "entry-5",
	oldLeafId: "entry-4",
	commonAncestorId: "entry-1",
	entriesToSummarize: [{ ...entry, customType: "note" }],
	userWantsSummary: true,
	label: "side",
};
const signal = () => new AbortController().signal;
const turnEnd = {
	turnIndex: 2,
	message,
	toolResults: [],
	messageEntryId: "entry-9",
	toolResultEntryIds: [],
	outcome: "completed" as const,
};
const boundary = ({ entries, continue: next }: { entries: unknown; continue: boolean }) => ({
	entries,
	continue: next,
});

interface InterceptorRow {
	readonly event: string;
	/** What the loop gets back from the hand for the forwarded event(s). */
	readonly hand: (send: (event: string, fields: object) => Promise<LoopReply>) => Promise<unknown>;
	/** What a local session's emit merges from the same extension. */
	readonly local: (runner: ExtensionRunner) => Promise<unknown>;
}

const ROWS: readonly InterceptorRow[] = [
	{
		event: "context, then context_with_system",
		hand: async (send) => {
			const context = await send("context", { messages: [note("hi")], source: "projection" });
			return (await send("context_with_system", { messages: context.messages })).messages;
		},
		local: (runner) => runner.emitContext([note("hi")], undefined, "projection"),
	},
	{
		event: "session_before_switch",
		hand: (send) => send("session_before_switch", { reason: "resume", targetSessionFile: "/sessions/2.jsonl" }),
		local: (runner) =>
			runner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: "/sessions/2.jsonl" }),
	},
	{
		event: "session_before_fork",
		hand: (send) => send("session_before_fork", { entryId: "entry-3", position: "at" }),
		local: (runner) => runner.emit({ type: "session_before_fork", entryId: "entry-3", position: "at" }),
	},
	{
		event: "session_before_tree",
		hand: (send) => send("session_before_tree", { preparation }),
		local: (runner) =>
			runner.emit({ type: "session_before_tree", preparation: toJson(preparation) as never, signal: signal() }),
	},
	{
		event: "turn_end",
		hand: async (send) =>
			boundary(
				(await send("turn_end", {
					...turnEnd,
					entries: [],
					continue: false,
					context: { ...preview, canContinue: true },
				})) as never,
			),
		local: async (runner) =>
			boundary(
				await runner.emitBoundary({ type: "turn_end", ...turnEnd }, () => ({ ...preview, canContinue: true })),
			),
	},
	{
		event: "agent_before_settle",
		hand: async (send) =>
			boundary(
				(await send("agent_before_settle", {
					outcome: "aborted",
					entries: [],
					continue: false,
					context: { ...preview, canContinue: false },
				})) as never,
			),
		local: async (runner) =>
			boundary(
				await runner.emitBoundary({ type: "agent_before_settle", outcome: "aborted" }, () => ({
					...preview,
					canContinue: false,
				})),
			),
	},
	{
		event: "message_end",
		hand: async (send) => (await send("message_end", { message })).message,
		local: (runner) => runner.emitMessageEnd({ type: "message_end", message }),
	},
	{
		event: "model_select",
		hand: (send) =>
			send("model_select", {
				model: MODEL,
				previousModel: PREVIOUS_MODEL,
				source: "cycle",
				systemPrompt: "base prompt",
				systemPromptOptions: { cwd: "/loop" },
			}),
		local: (runner) =>
			runner.emitModelSelect({
				type: "model_select",
				model: MODEL,
				previousModel: PREVIOUS_MODEL,
				source: "cycle",
				systemPrompt: "base prompt",
				systemPromptOptions: { cwd: "/loop" },
			}),
	},
	{
		event: "provider_login_start",
		hand: (send) => send("provider_login_start", { provider: "fixture" }),
		local: async (runner) => {
			const progress: string[] = [];
			const event = { type: "provider_login_start" as const, provider: "fixture", signal: signal() };
			await runner.emitProviderLoginStart({ ...event, progress: (line) => progress.push(line) });
			return { progress };
		},
	},
];

describe("a hosted loop's interceptors run the user's handlers on the hand (senpi#5898)", () => {
	it.each(ROWS)("$event: the loop gets the result a local session merges", async (row) => {
		const hand = await row.hand(user.send);

		expect(toJson(hand)).toEqual(toJson(await row.local(local)));
	});

	it("session_move_export carries back the state the user's handler wrote, as a local session's folder holds it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-5898-move-"));
		const failures = await local.emitSessionMove({ type: "session_move_export", moveId: "move-1", dir });

		const reply = await user.send("session_move_export", { moveId: "move-1" });

		expect([failures, reply.errors]).toEqual([[], undefined]);
		expect(reply.files).toEqual([
			{ path: "loop-event-ext" },
			{
				path: "loop-event-ext/state.json",
				data: readFileSync(join(dir, "loop-event-ext", "state.json")).toString("base64"),
			},
		]);
	});

	it("session_move_import hands the user's handler the state the loop carried, in a folder of its own", async () => {
		const state = Buffer.from(JSON.stringify({ moveId: "move-1" })).toString("base64");

		const reply = await user.send("session_move_import", {
			moveId: "move-1",
			redelivered: true,
			files: [{ path: "loop-event-ext" }, { path: "loop-event-ext/state.json", data: state }],
		});

		expect(reply.errors).toBeUndefined();
		expect(reply.notices?.map((notice) => notice.message)).toEqual(['{"moveId":"move-1"} true']);
	});

	it("refuses carried state whose path leaves the import folder, before any handler runs", async () => {
		await expect(
			user.send("session_move_import", {
				moveId: "move-1",
				redelivered: false,
				files: [{ path: "../escaped.json", data: "" }],
			}),
		).rejects.toThrow("malformed session_move_import payload");
	});

	it("refuses a handler result that has no JSON form instead of dropping part of it", async () => {
		const tree: ExtensionFactory = (pi) =>
			void pi.on("session_before_tree", () => ({ summary: { summary: "s", details: new Map([["k", 1]]) } }));
		const loaded = await createTestExtensionsResult([{ path: "/user/tree.ts", factory: tree }]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			undefined,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			loaded.eventBus,
		);
		const hooks = extensionLoopHooks(runner, "hand", process.cwd(), createLoopHookCall());

		await expect(hooks("session_before_tree", toJson({ sessionId: "s", idle: true, preparation }))).rejects.toThrow(
			"session_before_tree reply has no JSON form at summary.details (a Map)",
		);
	});
});
