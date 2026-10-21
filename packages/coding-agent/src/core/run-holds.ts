import type { EngineTurnHold, SessionHold } from "./engine-turn-hold.ts";

export type RunRef = { readonly kind: "dag" | "task" | "workpool" | "team"; readonly id: string };

type InheritedData = { parentSessionId: string; runRef: RunRef; highWater: number };
type LocalSeqData = { localSeq: number };

export type InheritResult = { readonly childSeq: number } | { readonly refused: "wrong_parent" };
export type ReleaseInheritedResult =
	| { readonly released: true; readonly otherHoldLive: boolean }
	| { readonly released: false; readonly reason: "stale" | "wrong_parent" | "not_held" };

const INHERITED_KEY = "inherited_hold";
const fenceKey = (runRef: RunRef): string => `run_fence:${runRef.kind}:${runRef.id}`;

function isRunRef(value: unknown): value is RunRef {
	if (typeof value !== "object" || value === null) return false;
	const ref = value as Record<string, unknown>;
	return typeof ref.kind === "string" && typeof ref.id === "string";
}

function inheritedData(hold: SessionHold | undefined): InheritedData | undefined {
	const data = hold?.data as Partial<InheritedData> | undefined;
	if (data === undefined || typeof data.parentSessionId !== "string" || typeof data.highWater !== "number")
		return undefined;
	return isRunRef(data.runRef)
		? { parentSessionId: data.parentSessionId, runRef: data.runRef, highWater: data.highWater }
		: undefined;
}

function localSeq(hold: SessionHold): number | undefined {
	const seq = (hold.data as Partial<LocalSeqData> | undefined)?.localSeq;
	return typeof seq === "number" ? seq : undefined;
}

/**
 * Run-level holds on the shared hold ledger (senpi#3811): fences on a parent for each run its Stop paused, and the
 * one inherited hold a child carries while its owning parent's run is paused. Every seq compared here comes from
 * the session's own ledger, so a parent's release can be checked against what it observed without a shared clock.
 */
export class RunHolds {
	private readonly ledger: EngineTurnHold;

	constructor(ledger: EngineTurnHold) {
		this.ledger = ledger;
	}

	fence(runRef: RunRef): void {
		this.ledger.addHold("run_fence", { key: fenceKey(runRef), data: { runRef } });
	}

	releaseFences(cause: "run_resume" | "run_cancelled", runRefs?: readonly RunRef[]): void {
		const keys = runRefs === undefined ? this.ledger.fences.map((hold) => hold.key) : runRefs.map(fenceKey);
		this.ledger.release(keys, cause);
	}

	holdsWake(details: unknown): boolean {
		const runRef = (details as { runRef?: unknown } | undefined)?.runRef;
		return isRunRef(runRef) && this.ledger.getHold(fenceKey(runRef)) !== undefined;
	}

	inheritedOwner(): InheritedData | undefined {
		return inheritedData(this.ledger.getHold(INHERITED_KEY));
	}

	stamp(): void {
		const localSeq = this.ledger.currentPauseSeq + 1;
		// Each Stop is its own record, so a second Stop bumps the seq even while the first is still held.
		this.ledger.addHold("session_hold", {
			key: `session_hold:${localSeq}`,
			data: { localSeq } satisfies LocalSeqData,
		});
	}

	releaseDirectStops(): void {
		const direct = this.ledger.holds.filter((hold) => hold.kind === "session_hold");
		this.ledger.release(
			direct.map((hold) => hold.key),
			"input",
		);
	}

	inherit(owner: { parentSessionId: string; parentPauseSeq: number; runRef: RunRef }): InheritResult {
		const current = this.inheritedOwner();
		if (current !== undefined && current.parentSessionId !== owner.parentSessionId)
			return { refused: "wrong_parent" };
		const highWater = Math.max(current?.highWater ?? 0, owner.parentPauseSeq);
		if (current !== undefined) this.ledger.release([INHERITED_KEY], "run_resume");
		this.ledger.addHold("inherited_hold", {
			key: INHERITED_KEY,
			data: { parentSessionId: owner.parentSessionId, runRef: owner.runRef, highWater } satisfies InheritedData,
		});
		return { childSeq: this.ledger.currentPauseSeq };
	}

	releaseInherited(request: {
		parentSessionId: string;
		parentPauseSeq: number;
		childSeqCutoff: number;
	}): ReleaseInheritedResult {
		const owner = this.inheritedOwner();
		if (owner === undefined) return { released: false, reason: "not_held" };
		if (owner.parentSessionId !== request.parentSessionId) return { released: false, reason: "wrong_parent" };
		if (request.parentPauseSeq !== owner.highWater) return { released: false, reason: "stale" };
		const direct = this.ledger.holds.filter((hold) => hold.kind === "session_hold");
		const observed = direct.filter((hold) => (localSeq(hold) ?? Number.POSITIVE_INFINITY) <= request.childSeqCutoff);
		this.ledger.release([INHERITED_KEY, ...observed.map((hold) => hold.key)], "run_resume");
		return { released: true, otherHoldLive: direct.length > observed.length };
	}
}
