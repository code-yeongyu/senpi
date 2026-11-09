import { TOOL_RESULT_PLACEHOLDER } from "@earendil-works/pi-ai";
import { canonicalDigest } from "./canonical-digest.ts";
import type {
	BatchManifest,
	BatchPlan,
	CallOutcome,
	ManifestCall,
	PrepareReply,
	SettleReply,
} from "./coordinator-types.ts";

/**
 * Release dependencies exactly as the agent loop has always ordered a batch: a sequential call waits for the previous sequential call and every parallel call since; a parallel call waits for the
 * previous sequential call only.
 */
export function batchDependencies(
	calls: readonly { readonly sequential: boolean }[],
): { readonly dependsOn: number[]; readonly wave: number }[] {
	const result: { dependsOn: number[]; wave: number }[] = [];
	let previousSequential: number | undefined;
	let parallelSince: number[] = [];
	for (const [index, call] of calls.entries()) {
		const anchor = previousSequential === undefined ? [] : [previousSequential];
		const dependsOn = call.sequential ? [...anchor, ...parallelSince] : anchor;
		const wave = Math.max(-1, ...dependsOn.map((dependency) => result[dependency]?.wave ?? -1)) + 1;
		result.push({ dependsOn, wave });
		if (call.sequential) {
			previousSequential = index;
			parallelSince = [];
		} else parallelSince.push(index);
	}
	return result;
}

export async function buildBatchManifest(issuer: string, plan: BatchPlan): Promise<BatchManifest> {
	const dependencies = batchDependencies(plan.calls);
	const calls: ManifestCall[] = [];
	for (const [sourceIndex, call] of plan.calls.entries()) {
		const placement = dependencies[sourceIndex] ?? { dependsOn: [], wave: 0 };
		calls.push({
			...call,
			sourceIndex,
			dependsOn: placement.dependsOn,
			wave: placement.wave,
			requestDigest: await canonicalDigest({ name: call.name, args: call.args }),
		});
	}
	const { calls: _calls, ...header } = plan;
	return { ...header, issuer, calls, manifestDigest: await canonicalDigest({ ...header, issuer, calls }) };
}

/**
 * A reply after which no later call is prepared and the decision is ABORT. A raw `settled` outcome other than a result
 * fails closed, `blocked` included: the ledger stores a blocked call and a preflight abort under the same reason, and
 * an executor that stopped a preparation itself answers `blocked` or `batch_abort` instead.
 */
export function abortCause(reply: PrepareReply): "batch_abort" | "interrupted_preparation" | undefined {
	if (reply.kind === "batch_abort") return "batch_abort";
	if (reply.kind === "settled" && reply.outcome.reason !== "result") return "interrupted_preparation";
	return undefined;
}

/**
 * Whether `index` and everything it transitively depends on have final outcomes. A call that settled at preparation
 * still finishes only after its own dependencies, as today's scheduler awaits them before every call's outcome.
 */
export function finished(
	calls: readonly { readonly dependsOn: readonly number[] }[],
	outcomes: readonly unknown[],
	index: number,
): boolean {
	const done = new Map<number, boolean>();
	const visit = (at: number): boolean => {
		const known = done.get(at);
		if (known !== undefined) return known;
		const result = outcomes[at] !== null && (calls[at]?.dependsOn ?? []).every((dependency) => visit(dependency));
		done.set(at, result);
		return result;
	};
	return visit(index);
}

export function settledOutcome(reply: SettleReply): CallOutcome {
	if (reply.kind === "unknown_execution") return { kind: "interrupted", reason: "unknown_execution", uncertain: true };
	const { outcome } = reply;
	switch (outcome.reason) {
		case "result":
			return { kind: "result", value: outcome.value };
		case "blocked":
			return { kind: "blocked", result: outcome.value };
		default:
			return { kind: "interrupted", reason: outcome.reason, uncertain: outcome.uncertain };
	}
}

/**
 * What the model is shown for a call whose run was cut short, so a replay equals today's (plan X12, K4): today's
 * pair-repair placeholder, never a rerun. Undefined for a call that settled, was blocked, or was aborted by a hook.
 */
export function interruptedReplayText(outcome: CallOutcome): string | undefined {
	if (outcome.kind === "interrupted") return TOOL_RESULT_PLACEHOLDER;
	if (outcome.kind === "not_run" && outcome.cause === "interrupted_preparation") return TOOL_RESULT_PLACEHOLDER;
	return undefined;
}
