// senpi#3864 (lifecycle addendum item 2, review r3 finding 1): `lastStop` names the run whose own end the turn
// deadline stopped. The deadline kind, that run's id and the stop time are captured when the deadline fires, before
// its durable write, and only that run's turn end carries them. A later run in the same open epoch must never
// inherit them: neither a run woken through prompt admission (which re-arms the deadline tracker) nor a run started
// by `_continueAgentAfterCurrentRun` (compaction resume, queued continuation, retry), which never re-arms it and so
// still sees the earlier run's deadline through `currentDeadline`.
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import type { SessionLifecycle } from "../../../src/core/session-lifecycle-types.ts";
import {
	type DeadlineStopData,
	TURN_DEADLINE_ENTRY_TYPE,
	type TurnDeadlineKind,
} from "../../../src/core/turn-deadline.ts";
import { createHarness, type Harness } from "../harness.ts";

const LIMIT_MS = 120_000;

/** Bounded wait for a session event under fake timers: the escape hatch runs on the real clock. */
function nextEvent(harness: Harness, predicate: (event: AgentSessionEvent) => boolean): Promise<AgentSessionEvent> {
	return new Promise((resolve, reject) => {
		const timeout = setRealTimeout(() => {
			unsubscribe();
			reject(new Error("Timed out waiting for a session event"));
		}, 10_000);
		const unsubscribe = harness.session.subscribe((event) => {
			if (!predicate(event)) return;
			clearRealTimeout(timeout);
			unsubscribe();
			resolve(event);
		});
	});
}

function lifecycleRecords(harness: Harness): LifecycleRecord[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
		.map((entry) => (entry as { data: LifecycleRecord }).data);
}

/** What a reopened session restores from the durable records alone (a reload). */
async function reloaded(harness: Harness): Promise<SessionLifecycle> {
	const { SessionLifecycleController } = await import("../../../src/core/session-lifecycle.ts");
	const controller = new SessionLifecycleController({
		sessionId: harness.sessionManager.getSessionId(),
		entries: harness.sessionManager.getEntries(),
		append: () => {},
		appendChild: () => {},
		appendCustody: () => {},
		emit: () => {},
		readRuntime: () => ({
			activity: {
				isStreaming: false,
				isBashRunning: false,
				isCompacting: false,
				hasSessionWork: false,
				hasActiveWakeSource: false,
			},
			pendingMessages: 0,
			human: [],
			holds: [],
		}),
	});
	controller.restoreComplete();
	return controller.snapshot;
}

describe("lastStop run correlation for a turn deadline (senpi#3864)", () => {
	let harness: Harness | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		harness?.cleanup();
		harness = undefined;
	});

	const cases = (["inactivity", "max_runtime"] as const).flatMap((kind) =>
		(["succeeds", "fails"] as const).flatMap((write) =>
			(["continuation", "prompt"] as const).map((wake) => ({ kind, write, wake })),
		),
	);

	it.each(cases)(
		"a $kind stop whose write $write stays on run A only; run B woken by $wake has none",
		async ({ kind, write, wake }: { kind: TurnDeadlineKind; write: "succeeds" | "fails"; wake: string }) => {
			// Given a session whose turn deadline will stop run A mid-stream.
			let ctx: ExtensionContext | undefined;
			const h = await createHarness({
				settings:
					kind === "inactivity"
						? { turn_inactivity_ms: LIMIT_MS, turn_max_runtime_ms: 0 }
						: { turn_inactivity_ms: 0, turn_max_runtime_ms: LIMIT_MS },
				fauxStreamOptions: { tokensPerSecond: 1 },
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_event, startCtx) => {
							ctx = startCtx;
						});
					},
				],
			});
			harness = h;
			await h.session.bindExtensions({ mode: "rpc" });
			if (!ctx) throw new Error("extension context was not captured");
			// The failing variant: the session file refuses the deadline-stop entry; lifecycle records still write.
			const append = h.sessionManager.appendCustomEntry.bind(h.sessionManager);
			vi.spyOn(h.sessionManager, "appendCustomEntry").mockImplementation((type, data, options) => {
				if (write === "fails" && type === TURN_DEADLINE_ENTRY_TYPE)
					throw new Error("session file refused the write");
				return append(type, data, options);
			});

			h.setResponses([fauxAssistantMessage(`partial answer ${"then silence ".repeat(150)}`)]);
			const idleA = nextEvent(h, (event) => event.type === "agent_idle");
			const prompting = h.session.prompt("say something then go quiet");
			await vi.advanceTimersByTimeAsync(LIMIT_MS);
			await vi.advanceTimersByTimeAsync(10_000);
			await idleA;
			await prompting;

			// Then run A carries its own deadline, its own run id, and the stop time captured once at the stop. A refused
			// deadline-stop write is named on the stop itself; the snapshot's own `persisted` is not changed by it.
			const runA = lifecycleRecords(h).at(-1)?.runId;
			expect(runA).toBeDefined();
			const stopEntry = h.sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom" && entry.customType === TURN_DEADLINE_ENTRY_TYPE) as
				| { data: DeadlineStopData }
				| undefined;
			expect(stopEntry === undefined).toBe(write === "fails");
			const stopAt = h.session.lifecycle.lastStop?.at;
			if (stopEntry) expect(stopAt).toBe(new Date(stopEntry.data.at).toISOString());
			const expectedStop = {
				cause: "deadline",
				deadline: kind,
				runId: runA,
				at: stopAt,
				epoch: 1,
				...(write === "fails" ? { persisted: false } : {}),
			};
			// The snapshot-level `persisted` and `selfSettleEligible` read the same whether the entry write succeeded or not.
			expect(h.session.lifecycle.lastStop?.persisted).toBe(write === "fails" ? false : undefined);
			expect(h.session.lifecycle).toMatchObject({ persisted: true, selfSettleEligible: true });
			expect(h.session.lifecycle.lastStop).toEqual(expectedStop);

			// And a reload before run B restores exactly the stop its record carries.
			expect((await reloaded(h)).lastStop).toEqual(expectedStop);

			// When run B starts in the same open epoch, either from a wake parked during an idle compaction and resumed by
			// agent.continue(), or from a wake admitted as a prompt.
			h.setResponses([fauxAssistantMessage("ok")]);
			const endB = nextEvent(h, (event) => event.type === "agent_end");
			let prompted: Promise<void> | undefined;
			const wakeMessage = { customType: "test-wake", content: "A watched job finished.", display: false };
			if (wake === "continuation") {
				const signal = ctx.beginCompaction?.({ reason: "extension" });
				await h.session.sendCustomMessage(wakeMessage, { triggerTurn: true, deliverAs: "followUp" });
				expect(h.session.agent.hasQueuedMessages()).toBe(true);
				ctx.endCompaction?.({ reason: "extension", signal, errorMessage: "Compaction did not apply: stale" });
			} else {
				prompted = h.session.sendCustomMessage(wakeMessage, { triggerTurn: true });
			}
			// Run B starts after the wake is delivered and streams on the fake clock, so time advances until it ends.
			let ended = false;
			void endB.then(() => {
				ended = true;
			});
			for (let tick = 0; tick < 30 && !ended; tick++) await vi.advanceTimersByTimeAsync(1_000);
			await endB;
			await prompted;
			await h.session.waitForSettledSessionWork();

			// Then no record of run B, from its opening while it runs to its clean end, carries A's stop.
			const runB = lifecycleRecords(h).at(-1)?.runId;
			expect(runB).toBeDefined();
			expect(runB).not.toBe(runA);
			const recordsB = lifecycleRecords(h).filter((record) => record.runId === runB);
			expect(recordsB.some((record) => record.state === "running" && record.runActive)).toBe(true);
			for (const record of recordsB) expect(record.lastStop).toBeUndefined();
			expect(h.session.lifecycle.epoch).toBe(1);
			expect(h.session.lifecycle.lastStop).toBeUndefined();
			// The continuation path never re-arms the tracker, so the session-level getter still names A's deadline.
			if (wake === "continuation") expect(h.session.currentDeadline?.kind).toBe(kind);

			// And a reload after run B restores no stop for it.
			expect((await reloaded(h)).lastStop).toBeUndefined();
		},
		30_000,
	);
});

it("attributes a recorded goal guard stop to the run that recorded it, never to the next run", async () => {
	// Given a session whose first run ends with a goal guard stop recorded, as the goal builtin appends it.
	let recordGuard = true;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("agent_end", () => {
					if (!recordGuard) return;
					recordGuard = false;
					pi.appendEntry("goal-continuation-stopped", {
						goalId: "goal-1",
						reason: "no-progress",
						at: 1_700_000_000_000,
					});
				});
			},
		],
	});
	try {
		await h.session.bindExtensions({ mode: "rpc" });
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		// When run A ends.
		await h.session.prompt("first");
		await h.session.waitForSettledSessionWork();

		// Then its stop carries the guard reason and time exactly as recorded.
		expect(h.session.lifecycle.lastStop).toMatchObject({
			cause: "goal_guard",
			guard: "no-progress",
			at: new Date(1_700_000_000_000).toISOString(),
			runId: lifecycleRecords(h).at(-1)?.runId,
		});

		// And run B, ending cleanly with that entry still on the branch, has no stop.
		await h.session.prompt("second");
		await h.session.waitForSettledSessionWork();
		expect(h.session.lifecycle.lastStop).toBeUndefined();
	} finally {
		h.cleanup();
	}
});
