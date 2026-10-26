// code-yeongyu/oh-my-openagent#10091: the runtime-identity handover answers within one bound with an admission
// outcome and never waits for global idle. Every phase transition runs on an injected clock and a controlled publication.
import { describe, expect, it } from "vitest";
import type { HandoverClientView } from "../../src/modes/rpc/host-handover-eligibility.ts";
import { type HandoverClock, HandoverCoordinator } from "../../src/modes/rpc/host-handover-coordinator.ts";
import {
	HANDOVER_DRAIN_SOFT_DEADLINE_MS,
	HANDOVER_OUTCOME_BOUND_MS,
} from "../../src/modes/rpc/host-handover-operation.ts";
import type {
	HandoverAnswer,
	HandoverOutcome,
	IdleHandoverRequest,
	RetainedSession,
} from "../../src/modes/rpc/host-idle-handover.ts";
import type { RpcHostHandoverOverdueEvent } from "../../src/modes/rpc/rpc-host-lifecycle-types.ts";

class TestClock implements HandoverClock {
	private time = 1_000;
	private readonly timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
	now(): number {
		return this.time;
	}
	schedule(ms: number, run: () => void): () => void {
		const timer = { at: this.time + ms, run, cancelled: false };
		this.timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	}
	advance(ms: number): void {
		this.time += ms;
		for (const timer of this.timers.filter((entry) => !entry.cancelled && entry.at <= this.time)) {
			timer.cancelled = true;
			timer.run();
		}
	}
}

interface Publication {
	readonly deadline: number;
	readonly settle: (outcome: HandoverOutcome) => void;
}

const request = (overrides: Partial<IdleHandoverRequest> = {}): IdleHandoverRequest => ({
	operationId: "op-1",
	ifInstanceId: "host-a",
	ifGeneration: 2,
	targetRuntimeBuildId: "sha256:target",
	launch: { command: "senpi", args: [] },
	hostArgs: [],
	env: {},
	...overrides,
});

function harness(
	options: {
		clients?: HandoverClientView;
		overlap?: boolean;
		retained?: RetainedSession[];
		journalFails?: boolean;
	} = {},
) {
	const clock = new TestClock();
	const publications: Publication[] = [];
	const publicationArrived: Array<() => void> = [];
	// Resolves once `perform` was called for the index-th time: the signal a publication is in flight.
	const publication = async (index = 0): Promise<Publication> => {
		for (;;) {
			const found = publications[index];
			if (found !== undefined) return found;
			await new Promise<void>((resolve) => publicationArrived.push(resolve));
		}
	};
	const seal: Array<"begin" | "end:published" | "end:abandoned"> = [];
	const announced: RpcHostHandoverOverdueEvent[] = [];
	let retained = options.retained ?? [];
	const recorded: string[] = [];
	const waiters = new Map<string, () => void>();
	const whenRecorded = (phase: string) =>
		new Promise<void>((resolve) => {
			if (recorded.includes(phase)) resolve();
			else waiters.set(phase, resolve);
		});
	const coordinator = new HandoverCoordinator({
		identity: () => ({ instanceId: "host-a", generation: 2, runtimeBuildId: "sha256:current" }),
		clients: () => options.clients ?? { sessions: 0, capableClients: 0, legacyClients: 0 },
		overlapEnabled: () => options.overlap === true,
		perform: (_request, deadline) =>
			new Promise<HandoverOutcome>((settle) => {
				publications.push({ deadline, settle });
				for (const arrived of publicationArrived.splice(0)) arrived();
			}),
		retained: () => retained,
		seal: {
			begin: () => seal.push("begin"),
			end: (published) => seal.push(published ? "end:published" : "end:abandoned"),
		},
		announce: (record) => announced.push(record),
		journal: {
			write: async (view) => {
				if (options.journalFails === true && view.phase === "checking_eligibility") throw new Error("disk full");
				recorded.push(view.phase);
				waiters.get(view.phase)?.();
			},
		},
		clock,
	});
	const published = {
		ok: true,
		successor: { pid: 7, instanceId: "host-b", generation: 3, runtimeBuildId: "sha256:target" },
	} as const;
	return {
		clock,
		coordinator,
		publications,
		publication,
		seal,
		announced,
		recorded,
		whenRecorded,
		published,
		setRetained: (sessions: RetainedSession[]) => {
			retained = sessions;
		},
	};
}

const phaseOf = (answer: HandoverAnswer) => (answer.kind === "operation" ? answer.view.phase : answer.reason);

describe("an overlapping handover that may not proceed", () => {
	it.each([
		["rollout_disabled", { sessions: 2, capableClients: 1, legacyClients: 0 }, false],
		["legacy_attached_client", { sessions: 0, capableClients: 1, legacyClients: 1 }, true],
	] as const)("is deferred as %s at once, launching nothing and holding nothing", async (reason, clients, overlap) => {
		const h = harness({ clients, overlap });

		const answer = await h.coordinator.begin(request());

		expect(answer).toMatchObject({
			kind: "operation",
			view: { phase: "migration_deferred", state: "handover_blocked", reason },
		});
		expect(h.publications).toEqual([]);
		expect(h.seal).toEqual([]);
	});
});

describe("a handover that may proceed", () => {
	it("answers once the successor serves new sessions, with the drain deadline it set", async () => {
		const h = harness({ clients: { sessions: 2, capableClients: 1, legacyClients: 0 }, overlap: true });

		const answering = h.coordinator.begin(request());
		const publication = await h.publication();
		expect(publication.deadline).toBe(1_000 + HANDOVER_OUTCOME_BOUND_MS);
		expect(h.coordinator.view()).toMatchObject({ phase: "preparing", state: "handover_pending" });
		publication.settle(h.published);

		expect(await answering).toMatchObject({
			kind: "operation",
			view: {
				phase: "draining",
				state: "handover_completed",
				successor: { instanceId: "host-b" },
				drainDeadlineAt: 1_000 + HANDOVER_DRAIN_SOFT_DEADLINE_MS,
			},
		});
		expect(h.seal).toEqual(["begin", "end:published"]);
	});

	it("rolls back without a successor and keeps this generation serving", async () => {
		const h = harness();

		const answering = h.coordinator.begin(request());
		(await h.publication()).settle({ ok: false, reason: "successor_unavailable" });

		expect(await answering).toMatchObject({
			view: { phase: "rolled_back", state: "handover_blocked", reason: "successor_unavailable" },
		});
		expect(h.seal).toEqual(["begin", "end:abandoned"]);
	});

	it("answers recovery_required at the bound and reports the publication that lands after it", async () => {
		const h = harness();

		const answering = h.coordinator.begin(request());
		const publication = await h.publication();
		h.clock.advance(HANDOVER_OUTCOME_BOUND_MS);
		expect(phaseOf(await answering)).toBe("recovery_required");

		publication.settle(h.published);
		await h.whenRecorded("draining");
		expect(h.coordinator.view()).toMatchObject({ phase: "draining", successor: { instanceId: "host-b" } });
		expect(h.recorded).toEqual(["checking_eligibility", "preparing", "recovery_required", "draining"]);
		expect(h.seal).toEqual(["begin", "end:abandoned", "end:published"]);
	});

	it("starts no other operation while a publication that passed the bound is still running", async () => {
		const h = harness();
		const answering = h.coordinator.begin(request());
		await h.publication();
		h.clock.advance(HANDOVER_OUTCOME_BOUND_MS);
		expect(phaseOf(await answering)).toBe("recovery_required");

		const other = await h.coordinator.begin(request({ operationId: "op-2", targetRuntimeBuildId: "sha256:other" }));

		expect(other).toMatchObject({ kind: "refused", reason: "handover_in_progress", detail: "op-1" });
		expect(h.publications).toHaveLength(1);
	});

	it("launches nothing when the operation cannot be recorded", async () => {
		const h = harness({ journalFails: true });

		const answer = await h.coordinator.begin(request());

		expect(answer).toMatchObject({
			view: { phase: "rolled_back", reason: expect.stringContaining("journal_unwritable") },
		});
		expect(h.publications).toEqual([]);
		expect(h.seal).toEqual([]);
	});
});

describe("the drain after publication", () => {
	it("reports sessions still held at the soft deadline once, and never stops them", async () => {
		const held = [{ sessionId: "busy", blockers: "turn" }];
		const h = harness({ retained: held });
		const answering = h.coordinator.begin(request());
		(await h.publication()).settle(h.published);
		await answering;

		h.clock.advance(HANDOVER_DRAIN_SOFT_DEADLINE_MS);
		h.clock.advance(HANDOVER_DRAIN_SOFT_DEADLINE_MS);

		expect(h.coordinator.view()).toMatchObject({ phase: "completed_with_retained_sessions", retained: held });
		expect(h.announced).toEqual([
			{ type: "host_handover_overdue", operation_id: "op-1", retained: [{ session_id: "busy", blockers: "turn" }] },
		]);
		await h.coordinator.drained();
		expect(h.coordinator.view()).toMatchObject({ phase: "completed", retained: [] });
	});

	it("completes at the soft deadline when nothing is held any more", async () => {
		const h = harness();
		const answering = h.coordinator.begin(request());
		(await h.publication()).settle(h.published);
		await answering;

		h.clock.advance(HANDOVER_DRAIN_SOFT_DEADLINE_MS);

		expect(h.coordinator.view()).toMatchObject({ phase: "completed" });
		expect(h.announced).toEqual([]);
	});
});

describe("repeated and competing requests", () => {
	it("answers a repeated operation with the operation that exists and refuses other terms", async () => {
		const h = harness();
		const first = h.coordinator.begin(request());
		(await h.publication()).settle(h.published);
		await first;

		expect(await h.coordinator.begin(request())).toMatchObject({ view: { operationId: "op-1", phase: "draining" } });
		expect(await h.coordinator.begin(request({ ifGeneration: 9 }))).toMatchObject({ reason: "operation_conflict" });
		expect(h.publications).toHaveLength(1);
	});

	it("joins an operation in progress for the same target and refuses another target", async () => {
		const h = harness();
		const first = h.coordinator.begin(request());
		const publication = await h.publication();

		const joined = h.coordinator.begin(request({ operationId: "op-2" }));
		expect(
			await h.coordinator.begin(request({ operationId: "op-3", targetRuntimeBuildId: "sha256:other" })),
		).toMatchObject({ kind: "refused", reason: "handover_in_progress", detail: "op-1" });
		publication.settle(h.published);

		expect(await joined).toMatchObject({ view: { operationId: "op-1", phase: "draining" } });
		await first;
		expect(h.publications).toHaveLength(1);
	});

	// senpi#4247: the successor's presenter deployment policy is one of the terms an operation is asked with.
	it("treats the presenter policy as part of an operation's terms", async () => {
		const h = harness();
		const first = h.coordinator.begin(request());
		const publication = await h.publication();

		const enforcing = await h.coordinator.begin(request({ operationId: "op-2", mcpPresenterEnforcement: true }));
		const conflicting = await h.coordinator.begin(request({ mcpPresenterEnforcement: true }));
		publication.settle(h.published);
		await first;

		expect(enforcing).toMatchObject({ kind: "refused", reason: "handover_in_progress", detail: "op-1" });
		expect(conflicting).toMatchObject({ kind: "refused", reason: "operation_conflict" });
		expect(h.publications).toHaveLength(1);
	});

	it("refuses a new operation once its successor serves: this generation no longer serves the endpoint", async () => {
		const h = harness();
		const first = h.coordinator.begin(request());
		(await h.publication()).settle(h.published);
		await first;

		expect(await h.coordinator.begin(request({ operationId: "op-2" }))).toMatchObject({ reason: "stale_generation" });
	});
});
