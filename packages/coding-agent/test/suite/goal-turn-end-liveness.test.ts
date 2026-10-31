import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	classifyTurnEnd,
	evaluateTurnEndLiveness,
	repeatsLastStall,
	TURN_END_LIVENESS_ENTRY_TYPE,
	TURN_END_RULES,
	type TurnEndKind,
	type TurnEndLivenessInput,
	type TurnEndLivenessVerdict,
	type WakeExpectation,
} from "../../src/core/extensions/builtin/goal/turn-end-liveness.ts";
import { collectTurnEndLivenessInput } from "../../src/core/extensions/builtin/goal/turn-end-liveness-report.ts";
import type { AgentEndEvent, ExtensionContext, ExtensionMode } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

function input(overrides: Partial<TurnEndLivenessInput> = {}): TurnEndLivenessInput {
	return {
		isChildSession: false,
		mode: "tui",
		ledgerHold: undefined,
		endedBy: "clean",
		willRetry: false,
		deadlineStop: false,
		goalStopped: false,
		openWork: { kind: "active-goal", goalId: "goal-1" },
		continuationQueued: undefined,
		expectations: [],
		budgetSpent: false,
		providerRetryAtMs: undefined,
		...overrides,
	};
}

const CHILD: WakeExpectation = { kind: "wake-source", source: "senpi-task" };
const MONITOR: WakeExpectation = { kind: "wake-source", source: "terminal-monitors" };
const GOAL_TIMER: WakeExpectation = { kind: "armed-timer", timer: "monitor" };
const RECOVERY: WakeExpectation = { kind: "recovery-staged" };
const QUESTION: WakeExpectation = { kind: "question-to-user" };
const QUEUED: WakeExpectation = { kind: "user-input-queued" };
const ENGINE_QUEUED: WakeExpectation = { kind: "pending-messages" };

/** One representative input per row of TURN_END_RULES, with the verdict that row must produce. */
const ROWS: ReadonlyArray<readonly [string, string, Partial<TurnEndLivenessInput>, TurnEndLivenessVerdict]> = [
	[
		"retry",
		"the core retries a provider error",
		{ endedBy: "provider-error", willRetry: true },
		{ kind: "continuing", via: "retry" },
	],
	[
		"retry",
		"the core retries a system abort",
		{ endedBy: "system-abort", willRetry: true, deadlineStop: true },
		{ kind: "continuing", via: "retry" },
	],
	[
		"ledger-hold",
		"an unattended session with a running child: the ledger holds every engine wake",
		{ ledgerHold: "unattended", expectations: [CHILD, MONITOR] },
		{ kind: "held", reason: "unattended" },
	],
	[
		"ledger-hold",
		"an unattended session whose goal queued a continuation",
		{ ledgerHold: "unattended", continuationQueued: "goal" },
		{ kind: "held", reason: "unattended" },
	],
	[
		"ledger-hold",
		"a session hold with a monitor and a stall",
		{ ledgerHold: "session_hold", endedBy: "provider-error", expectations: [MONITOR] },
		{ kind: "held", reason: "session_hold" },
	],
	[
		"ledger-hold",
		"a run fence after a system abort",
		{ ledgerHold: "run_fence", endedBy: "system-abort", openWork: { kind: "none" } },
		{ kind: "held", reason: "run_fence" },
	],
	[
		"ledger-hold",
		"an inherited hold in a child session with a running child",
		{ ledgerHold: "inherited_hold", isChildSession: true, expectations: [CHILD] },
		{ kind: "held", reason: "inherited_hold" },
	],
	[
		"wake",
		"a person's input released a hold during a deadline stop: the turn's own stop names it (#3900)",
		{ ledgerHold: "unattended", deadlineStop: true, expectations: [QUEUED] },
		{ kind: "waiting", on: [QUEUED], heldBy: "deadline-stop" },
	],
	[
		"wake",
		"a person's input released a hold after a user abort: the abort names it (#3900)",
		{ ledgerHold: "session_hold", endedBy: "user-abort", expectations: [QUEUED] },
		{ kind: "waiting", on: [QUEUED], heldBy: "user-abort" },
	],
	[
		"wake",
		"queued input retained after a user abort stays visible as a pending-messages fact (#3900)",
		{ endedBy: "user-abort", expectations: [ENGINE_QUEUED] },
		{ kind: "waiting", on: [ENGINE_QUEUED], heldBy: "user-abort" },
	],
	[
		"wake",
		"the user's own queued message releases an active hold",
		{ ledgerHold: "unattended", expectations: [QUEUED, CHILD] },
		{ kind: "waiting", on: [QUEUED, CHILD], heldBy: "unattended" },
	],
	[
		"ledger-hold",
		"a Stop hook or loop tick queued under a hold stays held: it is not the user's input",
		{ ledgerHold: "unattended", expectations: [ENGINE_QUEUED, CHILD] },
		{ kind: "held", reason: "unattended" },
	],
	[
		"wake",
		"an extension's queued message with no hold still starts a turn",
		{ expectations: [ENGINE_QUEUED] },
		{ kind: "waiting", on: [ENGINE_QUEUED] },
	],
	[
		"continuation-queued",
		"the goal lane queued a continuation",
		{ continuationQueued: "goal", isChildSession: true },
		{ kind: "continuing", via: "goal" },
	],
	[
		"continuation-queued",
		"the todo backstop nudged",
		{ continuationQueued: "todo-backstop", openWork: { kind: "open-todos", count: 2 } },
		{ kind: "continuing", via: "todo-backstop" },
	],
	[
		"non-interactive",
		"a print run exits even with a live monitor",
		{ mode: "print", expectations: [MONITOR] },
		{ kind: "held", reason: "non-interactive" },
	],
	["non-interactive", "a json run exits", { mode: "json" }, { kind: "held", reason: "non-interactive" }],
	["wake", "a running child will wake the parent", { expectations: [CHILD] }, { kind: "waiting", on: [CHILD] }],
	[
		"wake",
		"the goal's own backstop timer is armed",
		{ expectations: [GOAL_TIMER] },
		{ kind: "waiting", on: [GOAL_TIMER] },
	],
	[
		"wake",
		"a provider recovery is staged",
		{ endedBy: "provider-error", expectations: [RECOVERY] },
		{ kind: "waiting", on: [RECOVERY] },
	],
	["wake", "a queued message will start a turn", { expectations: [QUEUED] }, { kind: "waiting", on: [QUEUED] }],
	["wake", "a completed turn asked the user", { expectations: [QUESTION] }, { kind: "waiting", on: [QUESTION] }],
	[
		"wake",
		"a deadline stop with a running child: the child still delivers",
		{ deadlineStop: true, expectations: [CHILD] },
		{ kind: "waiting", on: [CHILD], heldBy: "deadline-stop" },
	],
	[
		"wake",
		"a user stop with a live monitor: the monitor still delivers",
		{ endedBy: "user-abort", expectations: [MONITOR] },
		{ kind: "waiting", on: [MONITOR], heldBy: "user-abort" },
	],
	[
		"wake",
		"a capped goal with a running child",
		{ goalStopped: true, budgetSpent: true, expectations: [CHILD] },
		{ kind: "waiting", on: [CHILD], heldBy: "goal-stopped" },
	],
	[
		"wake",
		"a child session with a live monitor",
		{ isChildSession: true, expectations: [MONITOR] },
		{ kind: "waiting", on: [MONITOR], heldBy: "child-session" },
	],
	[
		"held",
		"a deadline stop whose only wake is the goal's own timer",
		{ deadlineStop: true, expectations: [GOAL_TIMER, RECOVERY] },
		{ kind: "held", reason: "deadline-stop" },
	],
	[
		"held",
		"a deadline stop with nothing armed",
		{ endedBy: "system-abort", deadlineStop: true },
		{ kind: "held", reason: "deadline-stop" },
	],
	["held", "a user stop with nothing armed", { endedBy: "user-abort" }, { kind: "held", reason: "user-abort" }],
	["held", "a child session with nothing armed", { isChildSession: true }, { kind: "held", reason: "child-session" }],
	[
		"held",
		"a paused or blocked goal with nothing armed",
		{ goalStopped: true },
		{ kind: "held", reason: "goal-stopped" },
	],
	[
		"provider-error",
		"an error that names its reset time, even with nothing open",
		{ endedBy: "provider-error", providerRetryAtMs: 1_800_000, openWork: { kind: "none" } },
		{ kind: "stalled", reason: "provider-error", retryAtMs: 1_800_000 },
	],
	[
		"provider-error",
		"a policy rejection",
		{ endedBy: "policy-rejection" },
		{ kind: "stalled", reason: "provider-error" },
	],
	[
		"provider-error",
		"an errored turn's trailing question is not a wake",
		{ endedBy: "provider-error", providerRetryAtMs: 5_000, expectations: [QUESTION] },
		{ kind: "stalled", reason: "provider-error", retryAtMs: 5_000 },
	],
	[
		"aborted",
		"a system abort with nothing open",
		{ endedBy: "system-abort", openWork: { kind: "none" } },
		{ kind: "stalled", reason: "aborted", abortSource: "system" },
	],
	[
		"aborted",
		"a provider abort",
		{ endedBy: "provider-abort" },
		{ kind: "stalled", reason: "aborted", abortSource: "provider" },
	],
	[
		"aborted",
		"an abort with no attributed source",
		{ endedBy: "unknown-abort", openWork: { kind: "none" } },
		{ kind: "stalled", reason: "aborted" },
	],
	["budget", "a spent guard with open work", { budgetSpent: true }, { kind: "stalled", reason: "budget" }],
	[
		"no-wake",
		"open todos and nothing armed",
		{ openWork: { kind: "open-todos", count: 1 } },
		{ kind: "stalled", reason: "no-wake" },
	],
	["done", "a completed turn with nothing open", { openWork: { kind: "none" } }, { kind: "done" }],
];

describe("TURN_END_RULES (#3863): one decision table, one test per row", () => {
	it("covers every row of the table with at least one case", () => {
		expect(new Set(ROWS.map(([id]) => id))).toEqual(new Set(TURN_END_RULES.map((rule) => rule.id)));
	});

	it.each(ROWS)("row %s: %s", (id, _label, overrides, verdict) => {
		const case_ = input(overrides);
		expect(TURN_END_RULES.find((rule) => rule.when(case_))?.id).toBe(id);
		expect(evaluateTurnEndLiveness(case_)).toEqual(verdict);
	});
});

describe("TURN_END_RULES invariants over every stop x hold x open work x wake x queued combination (#3863)", () => {
	const stops: readonly TurnEndKind[] = [
		"clean",
		"user-abort",
		"system-abort",
		"provider-abort",
		"unknown-abort",
		"provider-error",
		"policy-rejection",
	];
	const holds: ReadonlyArray<Partial<TurnEndLivenessInput>> = [
		{},
		{ deadlineStop: true },
		{ goalStopped: true },
		{ isChildSession: true },
		{ budgetSpent: true },
		{ mode: "print" as ExtensionMode },
		{ ledgerHold: "unattended" },
	];
	const works: ReadonlyArray<TurnEndLivenessInput["openWork"]> = [
		{ kind: "none" },
		{ kind: "active-goal", goalId: "g" },
		{ kind: "open-todos", count: 1 },
	];
	const wakes: ReadonlyArray<readonly WakeExpectation[]> = [
		[],
		[CHILD],
		[GOAL_TIMER],
		[QUESTION],
		[QUEUED],
		[ENGINE_QUEUED],
	];
	const starts: ReadonlyArray<Partial<TurnEndLivenessInput>> = [
		{},
		{ willRetry: true },
		{ continuationQueued: "goal" },
	];
	const cases = stops.flatMap((endedBy) =>
		holds.flatMap((hold) =>
			works.flatMap((openWork) =>
				wakes.flatMap((expectations) =>
					starts.map((start) => input({ endedBy, openWork, expectations, ...hold, ...start })),
				),
			),
		),
	);

	it("enumerates every combination", () => {
		expect(cases).toHaveLength(stops.length * holds.length * works.length * wakes.length * starts.length);
	});

	it("never reports done for a turn that did not complete, or with work open", () => {
		for (const case_ of cases) {
			if (evaluateTurnEndLiveness(case_).kind !== "done") continue;
			expect(case_.endedBy).toBe("clean");
			expect(case_.openWork.kind).toBe("none");
		}
	});

	it("holds every engine wake while the hold ledger is active, unless the run in flight retries or the user queued input", () => {
		for (const case_ of cases) {
			if (case_.ledgerHold === undefined || case_.willRetry) continue;
			if (case_.expectations.includes(QUEUED)) {
				expect(evaluateTurnEndLiveness(case_).kind).not.toBe("held");
				continue;
			}
			expect(evaluateTurnEndLiveness(case_)).toEqual({ kind: "held", reason: case_.ledgerHold });
		}
	});

	it("reports continuing exactly when a turn will start from a retry or a queued continuation", () => {
		for (const case_ of cases) {
			const released = case_.ledgerHold === undefined || case_.expectations.includes(QUEUED);
			const starting = case_.willRetry || (case_.continuationQueued !== undefined && released);
			expect(evaluateTurnEndLiveness(case_).kind === "continuing").toBe(starting);
		}
	});

	it("reports waiting only on a wake that will deliver, never on the goal's own timer during a deadline stop", () => {
		for (const case_ of cases) {
			const verdict = evaluateTurnEndLiveness(case_);
			if (verdict.kind !== "waiting") continue;
			expect(verdict.on.length).toBeGreaterThan(0);
			if (case_.deadlineStop) expect(verdict.on).not.toContainEqual(GOAL_TIMER);
			if (case_.endedBy !== "clean") expect(verdict.on).not.toContainEqual(QUESTION);
		}
	});

	it("never calls a run that exits waiting, and holds or stalls when nothing will deliver", () => {
		for (const case_ of cases) {
			const verdict = evaluateTurnEndLiveness(case_);
			if (
				case_.mode === "print" &&
				!case_.willRetry &&
				case_.continuationQueued === undefined &&
				case_.ledgerHold === undefined
			) {
				expect(verdict).toEqual({ kind: "held", reason: "non-interactive" });
			}
			const nothingDelivers =
				!case_.willRetry &&
				case_.continuationQueued === undefined &&
				(case_.expectations.length === 0 ||
					(case_.deadlineStop && case_.expectations.every((w) => w === GOAL_TIMER)));
			if (nothingDelivers) expect(["held", "stalled", "done"]).toContain(verdict.kind);
		}
	});
});

describe("classifyTurnEnd (#3863)", () => {
	const end = (overrides: Partial<AgentEndEvent>): AgentEndEvent => ({
		type: "agent_end",
		messages: [fauxAssistantMessage("done")],
		willRetry: false,
		...overrides,
	});

	it.each([
		["clean", end({})],
		["user-abort", end({ aborted: true, abortSource: "user" })],
		["system-abort", end({ aborted: true, abortSource: "system" })],
		["provider-abort", end({ aborted: true, abortSource: "provider" })],
		[
			"provider-abort",
			end({ abortSource: "provider", messages: [fauxAssistantMessage("", { stopReason: "aborted" })] }),
		],
		["unknown-abort", end({ aborted: true })],
		["unknown-abort", end({ messages: [] })],
		["provider-error", end({ messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "529" })] })],
	] as const)("classifies %s", (kind, event) => {
		expect(classifyTurnEnd(event)).toBe(kind);
	});
});

describe("repeatsLastStall (#3863)", () => {
	const stall = (verdict: Record<string, unknown>): SessionEntry =>
		({
			type: "custom",
			id: "s",
			parentId: null,
			timestamp: "2026-10-21T00:00:00.000Z",
			customType: TURN_END_LIVENESS_ENTRY_TYPE,
			data: { verdict: { kind: "stalled", ...verdict }, openWork: { kind: "open-todos", count: 1 } },
		}) as SessionEntry;
	const userMessage = {
		type: "message",
		id: "u",
		parentId: null,
		timestamp: "2026-10-21T00:00:01.000Z",
		message: { role: "user", content: "keep going", timestamp: 1 },
	} as SessionEntry;

	it("skips a stall identical to the last one since the last user message", () => {
		expect(repeatsLastStall([stall({ reason: "no-wake" })], { kind: "stalled", reason: "no-wake" })).toBe(true);
	});

	it("records a provider stall again when its reset time moved", () => {
		const last = [stall({ reason: "provider-error", retryAtMs: 1_000 })];
		expect(repeatsLastStall(last, { kind: "stalled", reason: "provider-error", retryAtMs: 2_000 })).toBe(false);
		expect(repeatsLastStall(last, { kind: "stalled", reason: "provider-error", retryAtMs: 1_000 })).toBe(true);
	});

	it("records again after a user message or a different stall", () => {
		const verdict = { kind: "stalled", reason: "no-wake" } as const;
		expect(repeatsLastStall([stall({ reason: "no-wake" }), userMessage], verdict)).toBe(false);
		expect(repeatsLastStall([stall({ reason: "budget" })], verdict)).toBe(false);
		expect(repeatsLastStall([], verdict)).toBe(false);
	});
});

describe("collectTurnEndLivenessInput reads the hold ledger (#3863, senpi#3860)", () => {
	const monitor = {
		liveWakeSources: () => ["senpi-task"],
		scheduledContinuation: () => undefined,
		hasStagedRecovery: () => false,
	};
	const event: AgentEndEvent = { type: "agent_end", messages: [fauxAssistantMessage("done")], willRetry: false };
	const ctxWith = (extra: object): ExtensionContext =>
		({
			mode: "tui",
			hasPendingMessages: () => false,
			sessionManager: { getBranch: () => [], getHeader: () => undefined, getSessionId: () => "s" },
			...extra,
		}) as unknown as ExtensionContext;
	const state = {
		goal: null,
		todoOutcome: undefined,
		deadlineStop: false,
		continuationPending: false,
		monitor,
	};

	it.each([
		["an engine without the ledger", {}, undefined],
		["a released ledger", { engineTurnsHeld: (): boolean => false }, undefined],
		["an active ledger", { engineTurnsHeld: (): boolean => true }, "unattended"],
	] as const)("maps %s to ledgerHold %s", (_label, extra, ledgerHold) => {
		const collected = collectTurnEndLivenessInput(ctxWith(extra), event, state);
		expect(collected.ledgerHold).toBe(ledgerHold);
		expect(evaluateTurnEndLiveness(collected).kind).toBe(ledgerHold === undefined ? "waiting" : "held");
	});
});

describe("the queued-message wake follows the session's per-entry origin tag (#3863)", () => {
	const endOfTurn: AgentEndEvent = { type: "agent_end", messages: [fauxAssistantMessage("done")], willRetry: false };
	const state = {
		goal: null,
		todoOutcome: undefined,
		deadlineStop: false,
		continuationPending: false,
		monitor: { liveWakeSources: () => [], scheduledContinuation: () => undefined, hasStagedRecovery: () => false },
	};
	const ctxWith = (personQueued: boolean | undefined, held: boolean): ExtensionContext =>
		({
			mode: "tui",
			hasPendingMessages: () => true,
			...(personQueued === undefined ? {} : { hasQueuedPersonInput: (): boolean => personQueued }),
			...(held ? { engineTurnsHeld: (): boolean => true } : {}),
			sessionManager: { getBranch: () => [], getHeader: () => undefined, getSessionId: () => "s" },
		}) as unknown as ExtensionContext;

	it.each([
		["a person's queued input", true, "user-input-queued"],
		["only extension or engine messages", false, "pending-messages"],
		["an engine without the per-entry tag", undefined, "pending-messages"],
	] as const)("maps a pending queue holding %s to %s", (_label, personQueued, kind) => {
		expect(collectTurnEndLivenessInput(ctxWith(personQueued, false), endOfTurn, state).expectations).toEqual([
			{ kind },
		]);
	});

	it.each([
		[
			"a person's queued input releases the hold",
			true,
			{ kind: "waiting", on: [{ kind: "user-input-queued" }], heldBy: "unattended" },
		],
		["an extension-queued message stays held", false, { kind: "held", reason: "unattended" }],
	] as const)("under an active hold, %s", (_label, personQueued, verdict) => {
		expect(
			evaluateTurnEndLiveness(collectTurnEndLivenessInput(ctxWith(personQueued, true), endOfTurn, state)),
		).toEqual(verdict);
	});
});
