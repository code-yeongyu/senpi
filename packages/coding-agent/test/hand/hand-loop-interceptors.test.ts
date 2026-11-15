// senpi#5898: a hosted loop's interceptors run the user's handlers on the hand, and the result the loop gets back is the
// one a local session's emit merges from the same extension (C8: the loop waits for it).
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createLoopHookCall, type LateLoopRoute } from "../../src/modes/rpc/loop-hook-call.ts";
import { extensionLoopHooks } from "../../src/modes/rpc/loopless-loop-hooks.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { localRunner, type LoopReply, loopEventMachine, MODEL, PREVIOUS_MODEL, toJson } from "./loop-event-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

const noLateEffects: LateLoopRoute = () => {
	throw new Error("this test's hooks have no work that outlives their call");
};

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

interface BoundaryReply extends LoopReply {
	readonly entries: unknown[];
	readonly continue: boolean;
	readonly resume?: { readonly next: number; readonly extensionPath: string };
}

/** The loop's side of a stepped boundary (review L2): forward again from `resume.next` until the hand's part ends. */
async function stepBoundary(
	send: (event: string, fields: object) => Promise<LoopReply>,
	event: string,
	fields: object,
) {
	let state = { ...fields, entries: [] as unknown[], continue: false, from: 0 };
	for (;;) {
		const reply = (await send(event, state)) as BoundaryReply;
		if (reply.resume === undefined) return boundary(reply);
		state = { ...state, entries: reply.entries, continue: reply.continue, from: reply.resume.next };
	}
}

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
		hand: (send) => stepBoundary(send, "turn_end", { ...turnEnd, context: { ...preview, canContinue: true } }),
		local: async (runner) =>
			boundary(
				await runner.emitBoundary({ type: "turn_end", ...turnEnd }, () => ({ ...preview, canContinue: true })),
			),
	},
	{
		event: "agent_before_settle",
		hand: (send) =>
			stepBoundary(send, "agent_before_settle", { outcome: "aborted", context: { ...preview, canContinue: false } }),
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
		const hooks = extensionLoopHooks(runner, "hand", process.cwd(), createLoopHookCall(noLateEffects));

		await expect(hooks("session_before_tree", toJson({ sessionId: "s", idle: true, preparation }))).rejects.toThrow(
			"session_before_tree reply has no JSON form at summary.details (a Map)",
		);
	});

	it("stops a boundary after a hand handler drafts, so the next one sees the context the loop rebuilt (review L2)", async () => {
		const seen: number[] = [];
		const drafting =
			(name: string): ExtensionFactory =>
			(pi) =>
				void pi.on("turn_end", (event) => {
					seen.push(event.context.pendingMessages.length);
					return { entries: [...event.entries, { type: "custom", customType: name }] };
				});
		const loaded = await createTestExtensionsResult([
			{ path: "/user/a.ts", factory: drafting("a") },
			{ path: "/user/b.ts", factory: drafting("b") },
		]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			undefined,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			loaded.eventBus,
		);
		const hooks = extensionLoopHooks(runner, "hand", process.cwd(), createLoopHookCall(noLateEffects));
		const call = (from: number, entries: unknown[], pending: unknown[]) =>
			hooks(
				"turn_end",
				toJson({
					sessionId: "s",
					idle: false,
					...turnEnd,
					entries,
					continue: false,
					from,
					context: { ...preview, pendingMessages: pending, canContinue: true },
				}),
			) as Promise<BoundaryReply>;

		const first = await call(0, [], []);
		const second = await call(1, first.entries, [note("rebuilt"), note("by the loop")]);
		const last = await call(2, second.entries, []);

		expect(first).toEqual({
			entries: [{ type: "custom", customType: "a" }],
			continue: false,
			resume: { next: 1, extensionPath: "/user/a.ts" },
		});
		expect(second.resume).toEqual({ next: 2, extensionPath: "/user/b.ts" });
		expect(last).toEqual({ entries: second.entries, continue: false });
		expect(seen).toEqual([0, 2]);
	});
});
