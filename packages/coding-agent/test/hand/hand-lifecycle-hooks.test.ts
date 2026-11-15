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
import { deliverHandWake } from "@earendil-works/pi-agent-core";
import { openHandWakeOutbox } from "../../src/modes/hand/hand-wakes.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { createHarness } from "../suite/harness.ts";
import { brainInbox, connect } from "./hand-wake-fixture.ts";
import { type LifecycleHookEvent, writeLifecycleHook } from "./lifecycle-hook-fixture.ts";
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
				const wakes = [await brain.committed.next("the stop state"), await brain.committed.next("the follow-up")];

				expect([stopCounts(held), held.userMessages]).toEqual([[], undefined]);
				expect(wakes.map((wake) => [wake.source, wake.payload])).toEqual([
					[
						"entry",
						{ customType: STOP_STATE_CUSTOM_TYPE, data: expect.objectContaining({ count: 1 }), sessionId },
					],
					["user_message", { content: "keep going", options: { deliverAs: "followUp" }, sessionId }],
				]);
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

				expect(outcomes).toEqual(["delivered", "delivered"]);
				expect(JSON.stringify(loop.faux.getCallLog().map((entry) => entry.context))).toContain("keep going");
			} finally {
				link.close();
				loop.cleanup();
				await machine.close();
			}
		},
	);
});
