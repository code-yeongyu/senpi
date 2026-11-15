// senpi#5898: a hosted loop forwards its lifecycle events to the hand, so the user's SessionStart and Stop shell hooks
// and their extensions' compaction-failure and shutdown handlers run on the user's machine as they do in a local
// session, under the same handler budgets (brain/hand split, K5-K9; hooks builtin C8).
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as HookDispatcher from "../../src/core/extensions/builtin/hooks/dispatcher.ts";
import { STOP_STATE_CUSTOM_TYPE } from "../../src/core/extensions/builtin/hooks/stop-adapter.ts";
import { STOP_DRAIN_GRACE_MS } from "../../src/core/extensions/builtin/hooks/stop-lifecycle.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { type LifecycleReply, toJson, userMachine } from "./lifecycle-hook-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

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

/** A user extension whose shutdown handler runs until its own `event.signal` aborts; it announces that it started. */
const CANCELLABLE_SHUTDOWN_EXTENSION = `export default (pi) => {
	pi.on("session_shutdown", (event) => new Promise((resolve) => {
		event.signal?.addEventListener("abort", () => { globalThis.l2ShutdownAborted = true; resolve(); }, { once: true });
		globalThis.l2ShutdownStarted?.();
	}));
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

	// #6751 review M1: as in a local session, a turn that ends while the hand's background work is live holds its Stop
	// until the work drains; the held Stop then runs with the facts its agent_end carried, and its writes reach the loop
	// as late effects on the session's next reply. The loop carries either idle value at agent_end; neither may lose it.
	it.each([false, true])(
		"a Stop held for live background work runs once it drains, and its writes ride the next reply (idle %s)",
		async (idle) => {
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
				...agentEnd(),
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
			const next = (await user.machine.loopHooks("session_start", {
				...user.base,
				reason: "resume",
			})) as LifecycleReply;

			expect([stopCounts(held), held.userMessages]).toEqual([[], undefined]);
			expect(user.marks()).toBe("Stop\n");
			expect({ notices: next.notices, errors: next.errors }).toEqual({ notices: undefined, errors: undefined });
			expect(stopCounts(next)).toEqual([1]);
			expect(next.userMessages?.map((message) => message.content)).toEqual(["keep going"]);
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

	// #6753 review: the loop's cancel reached a shutdown handler's ctx.signal but not its event.signal, which only the cap aborted.
	it("the loop cancelling a session_shutdown call aborts its handlers' event.signal before the cap", async () => {
		const user = await userMachine({
			extension: CANCELLABLE_SHUTDOWN_EXTENSION,
			settings: { sessionShutdownHandlerWarnMs: 0, sessionShutdownHandlerTimeoutMs: 600_000 },
		});
		const started = new Promise<void>((resolve) => Object.assign(globalThis, { l2ShutdownStarted: resolve }));
		Object.assign(globalThis, { l2ShutdownAborted: false });
		const loopCall = new AbortController();

		const reply = user.machine.loopHooks(
			"session_shutdown",
			{ ...user.base, reason: "quit" },
			loopCall.signal,
		) as Promise<LifecycleReply>;
		await started;
		loopCall.abort();

		expect((await reply).errors).toBeUndefined();
		expect((globalThis as { l2ShutdownAborted?: boolean }).l2ShutdownAborted).toBe(true);
	});

	it("any other forwarded lifecycle handler that never settles is stopped at the hand's event handler cap", async () => {
		const user = await userMachine({ extension: HUNG_EXTENSION, settings: SHORT_BUDGETS });

		const reply = (await user.machine.loopHooks("agent_end", { ...user.base, ...agentEnd() })) as LifecycleReply;

		expect(reply.errors).toEqual([
			expect.objectContaining({ event: "agent_end", error: "handler timed out after 300ms" }),
		]);
	});
});
