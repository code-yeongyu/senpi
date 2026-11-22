// senpi#6795 review L1: a Stop held for background work on a hand dispatches after its loop-hook call ended. With no
// leaf in the carried session, its turn key falls back to the loop session's id, which the hand binds to the live call
// only (option A), so the fallback must use the id the Stop read when the turn ended, never a read at dispatch.
import { join } from "node:path";
import { fauxAssistantMessage, type JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STOP_STATE_CUSTOM_TYPE } from "../../src/core/extensions/builtin/hooks/stop-adapter.ts";
import { STOP_DRAIN_GRACE_MS } from "../../src/core/extensions/builtin/hooks/stop-lifecycle.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { openHandWakeOutbox } from "../../src/modes/hand/hand-wakes.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { brainInbox, connect } from "./hand-wake-fixture.ts";
import { writeLifecycleHook } from "./lifecycle-hook-fixture.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

describe("a Stop a hand holds for background work, with no leaf (senpi#6795)", () => {
	it("keys its stop state to the loop session's id read at agent_end, after its call ended", async () => {
		let bus: ExtensionAPI["events"] | undefined;
		const dirs = await handDirs("held-stop-no-leaf");
		writeLifecycleHook(dirs.cwd, "Stop");
		const brain = await brainInbox();
		const link = connect(brain, await openHandWakeOutbox(join(dirs.agentDir, "hand-wakes.json")));
		const machine = createLooplessHand(handConfiguration(dirs), {
			twoSidedHome: "hand",
			extensionFactories: [(pi) => void (bus = pi.events)],
			wakes: link.wakes,
		});
		const sessionId = `loop-${crypto.randomUUID()}`;
		const base = { sessionId, idle: false, scope: { id: `session-${sessionId}`, root: dirs.cwd } };
		try {
			await machine.loopHooks("session_start", { ...base, reason: "startup" });
			bus?.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 1 });
			await machine.loopHooks("agent_end", {
				...base,
				messages: JSON.parse(JSON.stringify([fauxAssistantMessage("done")])) as JsonValue,
				leafId: null,
				handEntries: [],
			});
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				bus?.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 0 });
				vi.advanceTimersByTime(STOP_DRAIN_GRACE_MS);
			} finally {
				vi.useRealTimers();
			}
			// The held Stop's first write reaches the loop as a durable wake: its stop state, not a dispatch failure.
			const first = await brain.committed.next("the held Stop's first write");

			expect({ source: first.source, payload: first.payload }).toMatchObject({
				source: "entry",
				payload: { customType: STOP_STATE_CUSTOM_TYPE, data: { turnKey: `0:${sessionId}`, count: 0 }, sessionId },
			});
		} finally {
			link.close();
			await machine.close();
		}
	});
});
