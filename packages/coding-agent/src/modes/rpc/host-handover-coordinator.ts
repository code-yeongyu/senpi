/**
 * The runtime-identity handover as the RUNNING host performs it (code-yeongyu/oh-my-openagent#10091). It replaces
 * the conditional idle handover, which refused every new prompt on this host until the whole host was idle.
 * Nothing here closes admission. `begin` answers within HANDOVER_OUTCOME_BOUND_MS with an admission outcome:
 *
 * - `migration_deferred`: an overlapping update is not allowed now (`host-handover-eligibility.ts`). Nothing is
 *   launched and nothing waits; a later request is a new operation.
 * - `draining`: a verified successor serves the public socket for NEW sessions, while every session this generation
 *   holds keeps running here until it settles and transfers strictly (`session-transfer-*.ts`).
 * - `rolled_back`: the successor could not be published; this generation keeps serving.
 * - `recovery_required`: the bound passed with the publication's fate unknown. The publication still settles the
 *   operation later, and no other operation starts until it has.
 *
 * After publication the drain has a SOFT deadline: sessions still held then are reported once
 * (`completed_with_retained_sessions`), never aborted or stopped.
 */
import { type HandoverClientView, judgeHandoverEligibility } from "./host-handover-eligibility.ts";
import {
	HANDOVER_DRAIN_SOFT_DEADLINE_MS,
	HANDOVER_OUTCOME_BOUND_MS,
	type HandoverPhase,
	legacyHandoverState,
	PUBLISHED_PHASES,
	SETTLED_PHASES,
} from "./host-handover-operation.ts";
import type {
	HandoverAnswer,
	HandoverOutcome,
	HandoverView,
	HostIdentityView,
	IdleHandoverRequest,
	RetainedSession,
} from "./host-idle-handover.ts";
import type { RpcHostHandoverOverdueEvent } from "./rpc-host-lifecycle-types.ts";

export interface HandoverClock {
	now(): number;
	schedule(ms: number, run: () => void): () => void;
}

export const realHandoverClock: HandoverClock = {
	now: () => Date.now(),
	schedule: (ms, run) => {
		const timer = setTimeout(run, Math.max(0, ms));
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

export interface HandoverCoordinatorOptions {
	readonly identity: () => HostIdentityView;
	readonly clients: () => HandoverClientView;
	readonly overlapEnabled: () => boolean;
	/** Launches, verifies and publishes the successor, giving up before `deadline` (on the clock's time). */
	readonly perform: (request: IdleHandoverRequest, deadline: number) => Promise<HandoverOutcome>;
	readonly retained: () => readonly RetainedSession[];
	/** Holds new admissions of clients that cannot follow a publication, from preparation to its outcome. */
	readonly seal?: { begin(): void; end(published: boolean): void };
	readonly announce?: (record: RpcHostHandoverOverdueEvent) => void;
	/** The durable record of every phase; acceptance waits for the first write. */
	readonly journal?: { write(view: HandoverView, request: IdleHandoverRequest): Promise<void> };
	readonly clock?: HandoverClock;
	readonly log?: (line: string) => void;
}

interface Operation {
	readonly request: IdleHandoverRequest;
	readonly deadline: number;
	view: HandoverView;
	readonly outcome: Promise<void>;
	readonly settle: () => void;
}

const REMEMBERED_OPERATIONS = 32;

export class HandoverCoordinator {
	private readonly options: HandoverCoordinatorOptions;
	private readonly clock: HandoverClock;
	private readonly operations = new Map<string, Operation>();
	private latest: Operation | undefined;
	/** A publication is in flight: its outcome, even one that lands after the bound, settles it first. */
	private publishing = false;
	private cancelDrainDeadline: (() => void) | undefined;

	constructor(options: HandoverCoordinatorOptions) {
		this.options = options;
		this.clock = options.clock ?? realHandoverClock;
	}

	view(): HandoverView | undefined {
		return this.latest?.view;
	}

	async begin(request: IdleHandoverRequest): Promise<HandoverAnswer> {
		const known = this.operations.get(request.operationId);
		if (known !== undefined) {
			return sameTerms(known.request, request)
				? this.answer(known)
				: refused("operation_conflict", "this operation id names other terms");
		}
		const latest = this.latest;
		if (latest !== undefined && PUBLISHED_PHASES.has(latest.view.phase)) {
			return refused("stale_generation", "this generation no longer serves the endpoint; its successor does");
		}
		if (latest !== undefined && (this.publishing || !isSettledOrRecovering(latest.view.phase))) {
			return latest.request.targetRuntimeBuildId === request.targetRuntimeBuildId &&
				samePresenterPolicy(latest.request, request)
				? this.answer(latest)
				: refused("handover_in_progress", latest.view.operationId);
		}
		const self = this.options.identity();
		if (self.instanceId !== request.ifInstanceId || self.generation !== request.ifGeneration) {
			return refused("stale_generation", `this host is ${self.instanceId} generation ${self.generation}`);
		}
		if (self.runtimeBuildId === request.targetRuntimeBuildId) return refused("already_current", self.runtimeBuildId);
		const operation = this.open(request);
		try {
			await this.options.journal?.write(operation.view, request);
		} catch (cause) {
			// Not accepted: nothing ran, and a request that joined meanwhile gets the same outcome.
			this.reach(operation, "rolled_back", { reason: `journal_unwritable: ${String(cause)}` });
			return this.answer(operation);
		}
		const verdict = judgeHandoverEligibility(this.options.clients(), this.options.overlapEnabled());
		if (verdict.kind === "deferred") this.reach(operation, "migration_deferred", { reason: verdict.reason });
		else void this.publish(operation);
		return this.answer(operation);
	}

	/** The drain emptied this generation, so everything it held has transferred; resolves once that is recorded. */
	async drained(): Promise<void> {
		const operation = this.latest;
		if (operation === undefined || !PUBLISHED_PHASES.has(operation.view.phase)) return;
		this.cancelDrainDeadline?.();
		await this.move(operation, "completed", { retained: [] });
	}

	dispose(): void {
		this.cancelDrainDeadline?.();
	}

	private open(request: IdleHandoverRequest): Operation {
		let settle: () => void = () => {};
		const outcome = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const operation: Operation = {
			request,
			deadline: this.clock.now() + HANDOVER_OUTCOME_BOUND_MS,
			view: {
				operationId: request.operationId,
				phase: "checking_eligibility",
				state: legacyHandoverState("checking_eligibility"),
				targetRuntimeBuildId: request.targetRuntimeBuildId,
			},
			outcome,
			settle,
		};
		this.latest = operation;
		this.operations.set(request.operationId, operation);
		for (const id of this.operations.keys()) {
			if (this.operations.size <= REMEMBERED_OPERATIONS) break;
			this.operations.delete(id);
		}
		return operation;
	}

	private async publish(operation: Operation): Promise<void> {
		this.publishing = true;
		void this.move(operation, "preparing", {});
		this.options.seal?.begin();
		const cancelBound = this.clock.schedule(operation.deadline - this.clock.now(), () => {
			// Held opens are admitted here again: a publication that lands later drains this generation anyway.
			this.options.seal?.end(false);
			this.reach(operation, "recovery_required", { reason: "publication outcome unknown at the bound" });
		});
		const outcome = await this.options
			.perform(operation.request, operation.deadline)
			.catch((cause: unknown): HandoverOutcome => ({
				ok: false,
				reason: `successor_unavailable: ${String(cause)}`,
			}));
		cancelBound();
		this.publishing = false;
		this.options.seal?.end(outcome.ok);
		if (!outcome.ok) {
			this.reach(operation, "rolled_back", { reason: outcome.reason });
			return;
		}
		const publishedAt = this.clock.now();
		this.reach(operation, "draining", {
			successor: outcome.successor,
			publishedAt,
			drainDeadlineAt: publishedAt + HANDOVER_DRAIN_SOFT_DEADLINE_MS,
		});
		this.cancelDrainDeadline = this.clock.schedule(HANDOVER_DRAIN_SOFT_DEADLINE_MS, () =>
			this.drainOverdue(operation),
		);
	}

	private drainOverdue(operation: Operation): void {
		const retained = this.options.retained();
		if (retained.length === 0) {
			void this.move(operation, "completed", { retained: [] });
			return;
		}
		void this.move(operation, "completed_with_retained_sessions", { retained });
		this.options.announce?.({
			type: "host_handover_overdue",
			operation_id: operation.view.operationId,
			retained: retained.map(({ sessionId, blockers }) => ({ session_id: sessionId, blockers })),
		});
	}

	/** An admission outcome: the answer every waiting `begin_handover` gets. */
	private reach(operation: Operation, phase: HandoverPhase, extra: Partial<HandoverView>): void {
		void this.move(operation, phase, extra);
		operation.settle();
	}

	/**
	 * One phase change, recorded. A published operation never goes back; a settled one moves only from retained
	 * sessions to completed. `recovery_required` is not settled: the publication it was waiting for still lands.
	 */
	private move(operation: Operation, phase: HandoverPhase, extra: Partial<HandoverView>): Promise<void> {
		const from = operation.view.phase;
		const unpublishing = PUBLISHED_PHASES.has(from) && !PUBLISHED_PHASES.has(phase);
		const reopening =
			SETTLED_PHASES.has(from) && !(from === "completed_with_retained_sessions" && phase === "completed");
		if (unpublishing || reopening) return Promise.resolve();
		operation.view = { ...operation.view, ...extra, phase, state: legacyHandoverState(phase) };
		this.options.log?.(`handover ${operation.view.operationId} ${phase}${extra.reason ? `: ${extra.reason}` : ""}`);
		return (this.options.journal?.write(operation.view, operation.request) ?? Promise.resolve()).catch(
			(cause: unknown) => {
				this.options.log?.(`handover ${operation.view.operationId} record not written: ${String(cause)}`);
			},
		);
	}

	private async answer(operation: Operation): Promise<HandoverAnswer> {
		await operation.outcome;
		return { kind: "operation", view: operation.view };
	}
}

function isSettledOrRecovering(phase: HandoverPhase): boolean {
	return SETTLED_PHASES.has(phase) || phase === "recovery_required";
}

function sameTerms(a: IdleHandoverRequest, b: IdleHandoverRequest): boolean {
	return (
		a.targetRuntimeBuildId === b.targetRuntimeBuildId &&
		samePresenterPolicy(a, b) &&
		a.ifInstanceId === b.ifInstanceId &&
		a.ifGeneration === b.ifGeneration
	);
}

/** The successor's presenter deployment policy is part of what an operation asks for (senpi#4247). */
function samePresenterPolicy(a: IdleHandoverRequest, b: IdleHandoverRequest): boolean {
	return Boolean(a.mcpPresenterEnforcement) === Boolean(b.mcpPresenterEnforcement);
}

function refused(reason: string, detail?: string): HandoverAnswer {
	return { kind: "refused", reason, ...(detail !== undefined && { detail }) };
}
