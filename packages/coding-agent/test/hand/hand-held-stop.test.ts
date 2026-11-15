// senpi#5898, #6751 and #6770: a Stop the hand holds for live background work runs as a local session's does. It waits
// while the work runs, runs once the work drains if no turn of the loop session is running by then, and its writes
// reach the loop as late effects. Only an event that proves a turn is running drops it, as locally only a turn's start
// does; a call that proves nothing (an input the loop handles itself, a preview) leaves it.
import { join } from "node:path";
import { deliverHandWake } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as HookDispatcher from "../../src/core/extensions/builtin/hooks/dispatcher.ts";
import { STOP_STATE_CUSTOM_TYPE } from "../../src/core/extensions/builtin/hooks/stop-adapter.ts";
import { STOP_DRAIN_GRACE_MS } from "../../src/core/extensions/builtin/hooks/stop-lifecycle.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { openHandWakeOutbox } from "../../src/modes/hand/hand-wakes.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { createHarness } from "../suite/harness.ts";
import { brainInbox, connect } from "./hand-wake-fixture.ts";
import { type LifecycleReply, toJson, userMachine, writeLifecycleHook } from "./lifecycle-hook-fixture.ts";
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

const stopCounts = (reply: LifecycleReply) =>
	(reply.entries ?? [])
		.filter((entry) => entry.customType === STOP_STATE_CUSTOM_TYPE)
		.map((entry) => (entry.data as { count: number }).count);

/**
 * A blocking Stop held on a hand whose only hooks are the user's shell hooks (no request hook advertised): one live
 * background job (what the terminal builtin announces for a background bash session) when the loop's turn ends.
 * `drain()` ends the job and runs out the drain grace, and answers whether the held Stop's dispatch started then.
 */
async function heldStop(idle: boolean) {
	let bus: ExtensionAPI["events"] | undefined;
	const user = await userMachine({
		hook: "Stop",
		stdout: { decision: "block", reason: "keep going" },
		extensionFactories: [
			(pi) => {
				bus = pi.events;
			},
		],
	});
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

describe("a Stop a hand holds for background work (senpi#5898)", () => {
	// #6751 review M1 + H3: as in a local session, a turn that ends while the hand's background work is live holds its
	// Stop until the work drains; the held Stop then runs with the facts its agent_end carried. Its writes (the stop
	// state and the block's follow-up) reach the loop as durable wakes, with no further call, so a block wakes an idle
	// loop: the brain delivers the follow-up and its session runs a turn. Either idle value at agent_end works the same.
	it.each([false, true])(
		"a Stop held for live background work that blocks wakes the loop through the wake lane (idle %s)",
		async (idle) => {
			let bus: ExtensionAPI["events"] | undefined;
			const dirs = await handDirs("h3-held-stop");
			writeLifecycleHook(dirs.cwd, "Stop", { decision: "block", reason: "keep going" });
			const brain = await brainInbox();
			const link = connect(brain, await openHandWakeOutbox(join(dirs.agentDir, "hand-wakes.json")));
			const machine = createLooplessHand(handConfiguration(dirs), {
				twoSidedHome: "hand",
				extensionFactories: [(pi) => void (bus = pi.events)],
				wakes: link.wakes,
			});
			const sessionId = `loop-${crypto.randomUUID()}`;
			const base = { sessionId, idle: false, scope: { id: `session-${sessionId}`, root: dirs.cwd } };
			let brainPi: ExtensionAPI | undefined;
			const loop = await createHarness({ cwd: dirs.cwd, extensionFactories: [(pi) => void (brainPi = pi)] });
			try {
				await loop.session.bindExtensions({ mode: "tui" });
				// The first call opens the scope's runtime, so its extensions (the bash stand-in among them) are loaded.
				await machine.loopHooks("session_start", { ...base, reason: "startup" });
				bus?.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 1 });
				const held = (await machine.loopHooks("agent_end", {
					...base,
					idle,
					messages: toJson([fauxAssistantMessage("done")]),
					leafId: "leaf-1",
					handEntries: [],
				})) as LifecycleReply;
				const ran = nextDispatchSettled();
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				try {
					bus?.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 0 });
					vi.advanceTimersByTime(STOP_DRAIN_GRACE_MS);
				} finally {
					vi.useRealTimers();
				}
				await ran;
				// The held Stop's writes arrive in order: its recorded output and stop state, then the block's follow-up.
				const wakes = [await brain.committed.next("the held Stop's first write")];
				while (wakes.at(-1)?.source !== "user_message") wakes.push(await brain.committed.next("the follow-up"));
				const stopState = wakes.find(
					(wake) => wake.source === "entry" && JSON.stringify(wake.payload).includes(STOP_STATE_CUSTOM_TYPE),
				);

				expect([stopCounts(held), held.userMessages]).toEqual([[], undefined]);
				expect(stopState?.payload).toMatchObject({ data: { count: 1 }, sessionId });
				expect(wakes.at(-1)?.payload).toEqual({
					content: "keep going",
					options: { deliverAs: "followUp" },
					sessionId,
				});
				const pi = brainPi;
				if (pi === undefined) throw new Error("the brain's extension did not load");
				loop.setResponses([fauxAssistantMessage("continued")]);
				const turn = new Promise<void>((resolve) => {
					const stop = loop.session.subscribe((event) => {
						if (event.type !== "agent_end") return;
						stop();
						resolve();
					});
				});
				const outcomes: string[] = [];
				await brain.inbox.drain(async (wake) => {
					outcomes.push(
						deliverHandWake(wake, {
							sendMessage: pi.sendMessage,
							sendUserMessage: pi.sendUserMessage,
							appendEntry: pi.appendEntry,
							notify: () => {},
							context: () => ({ mode: "tui", model: loop.session.model }),
						}),
					);
				});
				await turn;

				expect(outcomes).toEqual(wakes.map(() => "delivered"));
				expect(JSON.stringify(loop.faux.getCallLog().map((entry) => entry.context))).toContain("keep going");
			} finally {
				link.close();
				loop.cleanup();
				await machine.close();
			}
		},
	);

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
			call: "a before_agent_start that starts a turn",
			event: "before_agent_start",
			payload: { prompt: "p", systemPrompt: "s", trigger: "prompt", systemPromptOptions: {} },
			runs: false,
		},
		{
			// #6770 review round 2, M1: a continuation turn (auto-retry, compaction recovery, a queued continuation)
			// starts with agent_start and no before_agent_start, and on a hand with no request hook no model request
			// reaches it. The held Stop is dropped here by the Stop lifecycle's own agent_start handler; that agent_start
			// is also turn evidence by itself is guarded in loop-hook-turn-evidence.test.ts.
			call: "a continuation turn's agent_start, with no before_agent_start (the Stop lifecycle drops it)",
			event: "agent_start",
			payload: { idle: false },
			runs: false,
		},
		{
			call: "a continuation turn's turn_start",
			event: "turn_start",
			payload: { idle: false, turnIndex: 0, timestamp: 1 },
			runs: false,
		},
		{
			call: "a model request sent mid-turn",
			event: "before_provider_request",
			payload: { input: { payload: { messages: [] } }, idle: false },
			runs: false,
		},
	];
	it.each(between)("after $call: runs on the drain: $runs", async ({ event, payload, runs }) => {
		const { user, drain } = await heldStop(false);
		await user.machine.loopHooks(event, toJson({ ...user.base, idle: true, ...payload }));

		const ran = runs ? nextDispatchSettled() : undefined;
		const dispatched = drain();
		await ran;

		expect({ dispatched, marks: user.marks() }).toEqual({ dispatched: runs, marks: runs ? "Stop\n" : "" });
	});
});
