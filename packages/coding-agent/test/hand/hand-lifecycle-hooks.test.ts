// senpi#5898: a hosted loop forwards its lifecycle events to the hand, so the user's SessionStart shell hooks run on
// the user's machine as they do in a local session (brain/hand split, K5; hooks builtin C8).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as HookDispatcher from "../../src/core/extensions/builtin/hooks/dispatcher.ts";
import { STOP_STATE_CUSTOM_TYPE } from "../../src/core/extensions/builtin/hooks/stop-adapter.ts";
import { STOP_DRAIN_GRACE_MS } from "../../src/core/extensions/builtin/hooks/stop-lifecycle.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI, InlineExtension } from "../../src/core/extensions/types.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { type LifecycleHookEvent, writeLifecycleHook } from "./lifecycle-hook-fixture.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";

// A held Stop runs from the drain timer, with no reply to await. The real dispatcher runs; each dispatch is numbered
// when it starts, and once it settles and the continuations it started have run (the Stop's result applied), it tells
// whoever waits.
const dispatches = vi.hoisted(() => ({ started: 0, settled: new Set<(seq: number) => void>() }));
vi.mock("../../src/core/extensions/builtin/hooks/dispatcher.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof HookDispatcher>();
	return {
		...actual,
		dispatchHookEvent: (options: Parameters<typeof actual.dispatchHookEvent>[0]) => {
			const seq = ++dispatches.started;
			const run = actual.dispatchHookEvent(options);
			const settled = () => setImmediate(() => [...dispatches.settled].forEach((listener) => listener(seq)));
			run.then(settled, settled);
			return run;
		},
	};
});

/**
 * The settlement of the next dispatch that starts after this call. A Stop that never runs fails by the test's own
 * timeout; no shorter timer races a real hook process on a loaded machine.
 */
function nextDispatchSettled(): Promise<void> {
	const after = dispatches.started;
	const settled = Promise.withResolvers<void>();
	const listener = (seq: number) => {
		if (seq > after) settled.resolve();
	};
	dispatches.settled.add(listener);
	return settled.promise.finally(() => dispatches.settled.delete(listener));
}

afterEach(cleanupHands);

async function userMachine(event: LifecycleHookEvent, stdout?: unknown, extensionFactories: InlineExtension[] = []) {
	const dirs = await handDirs("k5-lifecycle");
	writeLifecycleHook(dirs.cwd, event, stdout);
	const machine = createLooplessHand(handConfiguration(dirs), { twoSidedHome: "hand", extensionFactories });
	const sessionId = `loop-${crypto.randomUUID()}`;
	const base = { sessionId, idle: false, scope: { id: `session-${sessionId}`, root: dirs.cwd } };
	const marker = join(dirs.cwd, "hook-ran.txt");
	return {
		machine,
		base,
		marks: () => (existsSync(marker) ? readFileSync(marker, "utf-8") : ""),
	};
}

interface LifecycleReply {
	readonly sent?: { message: { content: unknown } }[];
	readonly entries?: { customType: string; data?: unknown }[];
	readonly userMessages?: { content: unknown; options?: unknown }[];
	readonly errors?: unknown[];
}

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** The loop's side of the session port: it appends each entry a reply returns as its own custom entry. */
const asHandEntries = (reply: LifecycleReply, from: number) =>
	(reply.entries ?? []).map((entry, index) => ({
		type: "custom",
		id: `hand-${from + index}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: entry.customType,
		data: entry.data,
	}));

const stopCounts = (reply: LifecycleReply) =>
	(reply.entries ?? [])
		.filter((entry) => entry.customType === STOP_STATE_CUSTOM_TYPE)
		.map((entry) => (entry.data as { count: number }).count);

/**
 * A blocking Stop held on a hand: one live background job (what the terminal builtin announces for a background bash
 * session) when the loop's turn ends. `drain()` ends the job and runs out the drain grace, and answers whether the
 * held Stop's dispatch started then.
 */
async function heldStop(idle: boolean) {
	let bus: ExtensionAPI["events"] | undefined;
	const user = await userMachine("Stop", { decision: "block", reason: "keep going" }, [
		(pi) => {
			bus = pi.events;
		},
	]);
	// The first call opens the scope's runtime, so its extensions (the bash stand-in among them) are loaded.
	await user.machine.loopHooks("session_start", { ...user.base, reason: "startup" });
	bus?.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 1 });
	const held = (await user.machine.loopHooks("agent_end", {
		...user.base,
		idle,
		messages: toJson([fauxAssistantMessage("done")]),
		leafId: "leaf-1",
		handEntries: [],
	})) as LifecycleReply;
	const drain = () => {
		const before = dispatches.started;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			bus?.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 0 });
			vi.advanceTimersByTime(STOP_DRAIN_GRACE_MS);
		} finally {
			vi.useRealTimers();
		}
		return dispatches.started > before;
	};
	return { user, held, drain };
}

describe("a hosted loop's lifecycle hooks run on the user's machine (senpi#5898)", () => {
	it("session_start runs the user's SessionStart hook there and returns its context for the loop to send", async () => {
		const user = await userMachine("SessionStart", {
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context from the user machine" },
		});

		const reply = (await user.machine.loopHooks("session_start", {
			...user.base,
			reason: "startup",
		})) as LifecycleReply;

		expect(user.marks()).toBe("SessionStart\n");
		expect(reply.errors).toBeUndefined();
		expect(JSON.stringify(reply.sent?.map((sent) => sent.message.content))).toContain(
			"context from the user machine",
		);
	});

	it("agent_end runs the user's Stop hook there and returns its stop state as an entry for the loop's session", async () => {
		const user = await userMachine("Stop");

		const reply = (await user.machine.loopHooks("agent_end", {
			...user.base,
			messages: toJson([fauxAssistantMessage("done")]),
			leafId: "leaf-1",
			handEntries: [],
		})) as LifecycleReply;

		expect(user.marks()).toBe("Stop\n");
		expect(reply.errors).toBeUndefined();
		expect(stopCounts(reply)).toEqual([0]);
		expect(reply.userMessages).toBeUndefined();
	});

	it("a blocking Stop hook continues the turn through the loop, counting reentries only from the entries it carries", async () => {
		const user = await userMachine("Stop", { decision: "block", reason: "keep going" });
		const call = (handEntries: unknown[]) =>
			user.machine.loopHooks("agent_end", {
				...user.base,
				messages: toJson([fauxAssistantMessage("done")]),
				leafId: "leaf-1",
				handEntries: toJson(handEntries),
			}) as Promise<LifecycleReply>;

		const first = await call([]);
		const second = await call(asHandEntries(first, 0));
		// The loop sends only the hand's entries after its last compaction: what it carries is all the hand reads.
		const afterCompaction = await call([]);

		expect([stopCounts(first), stopCounts(second), stopCounts(afterCompaction)]).toEqual([[1], [2], [1]]);
		expect(first.userMessages?.map((message) => message.content)).toEqual(["keep going"]);
		expect([first.errors, second.errors, afterCompaction.errors]).toEqual([undefined, undefined, undefined]);
	});

	// #6751 review M1: as in a local session, a turn that ends while the hand's background work is live holds its Stop
	// until the work drains; the held Stop then runs with the facts its agent_end carried, and its writes reach the loop
	// as late effects on the session's next reply. The loop carries either idle value at agent_end; neither may lose it.
	it.each([false, true])(
		"a Stop held for live background work runs once it drains, and its writes ride the next reply (idle %s)",
		async (idle) => {
			const { user, held, drain } = await heldStop(idle);

			const ran = nextDispatchSettled();
			expect(drain()).toBe(true);
			await ran;
			const next = (await user.machine.loopHooks("session_start", {
				...user.base,
				reason: "resume",
			})) as LifecycleReply & { readonly notices?: unknown[] };

			expect([stopCounts(held), held.userMessages]).toEqual([[], undefined]);
			expect(user.marks()).toBe("Stop\n");
			expect({ notices: next.notices, errors: next.errors }).toEqual({ notices: undefined, errors: undefined });
			expect(stopCounts(next)).toEqual([1]);
			expect(next.userMessages?.map((message) => message.content)).toEqual(["keep going"]);
		},
	);

	// #6751 follow-up (review L2): locally only `agent_start` drops a held Stop. On a hand the call that starts a turn is a
	// real `before_agent_start`; any other call between the turn's end and the drain leaves the held Stop to run.
	const between = [
		{
			call: "an input the loop handles without a turn",
			event: "input",
			payload: { inputId: "in-1", text: "/status", source: "interactive", attribution: "user" },
			runs: true,
		},
		{
			call: "a preview before_agent_start",
			event: "before_agent_start",
			payload: { prompt: "p", systemPrompt: "s", trigger: "prompt", systemPromptOptions: {}, preview: true },
			runs: true,
		},
		{
			// #6770 review M1: a continuation turn (auto-retry, compaction recovery, a queued continuation) starts with
			// agent_start and no before_agent_start; the first a hand sees of it is its model request.
			call: "a continuation turn's model request, with no before_agent_start",
			event: "before_provider_request",
			payload: { input: { payload: { messages: [] } }, idle: false },
			runs: false,
		},
		{
			call: "a before_agent_start that starts a turn",
			event: "before_agent_start",
			payload: { prompt: "p", systemPrompt: "s", trigger: "prompt", systemPromptOptions: {} },
			runs: false,
		},
	];
	it.each(between)("a held Stop after $call: runs on the drain: $runs", async ({ event, payload, runs }) => {
		const { user, drain } = await heldStop(false);
		await user.machine.loopHooks(event, toJson({ ...user.base, idle: true, ...payload }));

		const ran = runs ? nextDispatchSettled() : undefined;
		const dispatched = drain();
		await ran;

		expect({ dispatched, marks: user.marks() }).toEqual({ dispatched: runs, marks: runs ? "Stop\n" : "" });
	});
});
