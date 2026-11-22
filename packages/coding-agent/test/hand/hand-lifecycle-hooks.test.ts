// senpi#5898: a hosted loop forwards its lifecycle events to the hand, so the user's SessionStart and Stop shell hooks
// and their extensions' compaction-failure and shutdown handlers run on the user's machine as they do in a local
// session, under the same handler budgets (brain/hand split, K5-K9; hooks builtin C8). A Stop held for background work
// has its own file, hand-held-stop.test.ts.
// session, under the same handler budgets (brain/hand split, K5-K9; hooks builtin C8).
import { join } from "node:path";
import { deliverHandWake } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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

// A held Stop runs from the drain timer, with no reply to await. The real dispatcher runs; once a dispatch settles and
// the continuations it started have run (the Stop's result applied), it tells whoever waits.
const dispatchSettled = vi.hoisted(() => new Set<() => void>());
vi.mock("../../src/core/extensions/builtin/hooks/dispatcher.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof HookDispatcher>();
	return {
		...actual,
		dispatchHookEvent: (options: Parameters<typeof actual.dispatchHookEvent>[0]) => {
			const run = actual.dispatchHookEvent(options);
			const settled = () => setImmediate(() => [...dispatchSettled].forEach((listener) => listener()));
			run.then(settled, settled);
			return run;
		},
	};
});

/** The next hook dispatch's settlement, bounded: a Stop that never runs fails the wait instead of hanging. */
function nextDispatchSettled(): Promise<void> {
	const settled = Promise.withResolvers<void>();
	const listener = () => settled.resolve();
	dispatchSettled.add(listener);
	const bound = setTimeout(() => settled.reject(new Error("the held Stop never ran")), 15_000);
	return settled.promise.finally(() => {
		clearTimeout(bound);
		dispatchSettled.delete(listener);
	});
}

afterEach(cleanupHands);

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

const FAILURE_AND_SHUTDOWN_EXTENSION = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default (pi) => {
	pi.on("session_compact_failed", (event, ctx) => appendFileSync(join(ctx.cwd, "hook-ran.txt"), \`session_compact_failed \${event.reason} \${event.errorMessage}\\n\`));
	pi.on("session_shutdown", (event, ctx) => appendFileSync(join(ctx.cwd, "hook-ran.txt"), \`session_shutdown \${event.reason} \${ctx.sessionManager.getSessionId()}\\n\`));
};`;

/** A user extension whose shutdown and agent_end handlers never settle; the shutdown one records its signal's abort. */
const HUNG_EXTENSION = `export default (pi) => {
	pi.on("session_shutdown", (event) => new Promise(() => event.signal?.addEventListener("abort", () => { globalThis.m1ShutdownAborted = true; })));
	pi.on("agent_end", () => new Promise(() => {}));
};`;

/** Short caps, so a hung handler is stopped within the test (the shipped caps are 10 s and 20 min). */
const SHORT_BUDGETS = {
	sessionShutdownHandlerWarnMs: 0,
	sessionShutdownHandlerTimeoutMs: 300,
	extensionEventHandlerWarnMs: 0,
	extensionEventHandlerTimeoutMs: 300,
};

const agentEnd = (handEntries: unknown[] = []) => ({
	messages: toJson([fauxAssistantMessage("done")]),
	leafId: "leaf-1",
	handEntries: toJson(handEntries),
});

describe("a hosted loop's lifecycle hooks run on the user's machine (senpi#5898)", () => {
	it("session_start runs the user's SessionStart hook there and returns its context for the loop to send", async () => {
		const user = await userMachine({
			hook: "SessionStart",
			stdout: {
				hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context from the user machine" },
			},
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
		const user = await userMachine({ hook: "Stop" });

		const reply = (await user.machine.loopHooks("agent_end", { ...user.base, ...agentEnd() })) as LifecycleReply;

		expect(user.marks()).toBe("Stop\n");
		expect(reply.errors).toBeUndefined();
		expect(stopCounts(reply)).toEqual([0]);
		expect(reply.userMessages).toBeUndefined();
	});

	it("a blocking Stop hook continues the turn through the loop, counting reentries only from the entries it carries", async () => {
		const user = await userMachine({ hook: "Stop", stdout: { decision: "block", reason: "keep going" } });
		const call = (handEntries: unknown[]) =>
			user.machine.loopHooks("agent_end", { ...user.base, ...agentEnd(handEntries) }) as Promise<LifecycleReply>;

		const first = await call([]);
		const second = await call(asHandEntries(first, 0));
		// The loop sends only the hand's entries after its last compaction: what it carries is all the hand reads.
		const afterCompaction = await call([]);

		expect([stopCounts(first), stopCounts(second), stopCounts(afterCompaction)]).toEqual([[1], [2], [1]]);
		expect(first.userMessages?.map((message) => message.content)).toEqual(["keep going"]);
		expect([first.errors, second.errors, afterCompaction.errors]).toEqual([undefined, undefined, undefined]);
	});

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

	it("a user extension's compaction-failure and shutdown handlers run there, bound to the loop session", async () => {
		const user = await userMachine({ extension: FAILURE_AND_SHUTDOWN_EXTENSION });

		const failed = (await user.machine.loopHooks("session_compact_failed", {
			...user.base,
			reason: "threshold",
			errorMessage: "summary failed",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		})) as LifecycleReply;
		const shutdown = (await user.machine.loopHooks("session_shutdown", {
			...user.base,
			reason: "quit",
		})) as LifecycleReply;

		expect([failed.errors, shutdown.errors]).toEqual([undefined, undefined]);
		expect(user.marks()).toBe(
			`session_compact_failed threshold summary failed\nsession_shutdown quit ${user.base.sessionId}\n`,
		);
	});

	it("a session_shutdown handler that never settles is stopped at the hand's shutdown cap, its signal aborted", async () => {
		const user = await userMachine({ extension: HUNG_EXTENSION, settings: SHORT_BUDGETS });
		Object.assign(globalThis, { m1ShutdownAborted: false });

		const reply = (await user.machine.loopHooks("session_shutdown", {
			...user.base,
			reason: "quit",
		})) as LifecycleReply;

		expect((globalThis as { m1ShutdownAborted?: boolean }).m1ShutdownAborted).toBe(true);
		expect(reply.errors).toEqual([
			expect.objectContaining({ event: "session_shutdown", error: "handler timed out after 300ms" }),
		]);
	});

	it("any other forwarded lifecycle handler that never settles is stopped at the hand's event handler cap", async () => {
		const user = await userMachine({ extension: HUNG_EXTENSION, settings: SHORT_BUDGETS });

		const reply = (await user.machine.loopHooks("agent_end", { ...user.base, ...agentEnd() })) as LifecycleReply;

		expect(reply.errors).toEqual([
			expect.objectContaining({ event: "agent_end", error: "handler timed out after 300ms" }),
		]);
	});
});
