import { TOOL_RESULT_PLACEHOLDER } from "@earendil-works/pi-ai";
import type { StoreValue } from "../durable/store.ts";
import type {
	BatchManifest,
	BatchPlan,
	CallOutcome,
	ManifestCall,
	PrepareReply,
	SettleReply,
} from "./coordinator-types.ts";

/**
 * Release dependencies exactly as today's scheduler assigns them (agent-loop.ts, executeToolCallsParallel): a
 * sequential call waits for the previous sequential call and every parallel call since; a parallel call waits for the
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

function canonical(value: StoreValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

async function digest(value: StoreValue): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
			requestDigest: await digest({ name: call.name, args: call.args }),
		});
	}
	const { calls: _calls, ...header } = plan;
	return { ...header, issuer, calls, manifestDigest: await digest({ ...header, issuer, calls }) };
}

/** A reply after which no later call is prepared and the decision is ABORT. */
export function abortCause(reply: PrepareReply): "batch_abort" | "interrupted_preparation" | undefined {
	if (reply.status === "batch_abort") return "batch_abort";
	if (reply.status === "settled" && reply.outcome.reason !== "result") return "interrupted_preparation";
	return undefined;
}

export function settledOutcome(reply: SettleReply): CallOutcome {
	if (reply.status === "unknown_execution")
		return { kind: "interrupted", reason: "unknown_execution", uncertain: true };
	const { outcome } = reply;
	return outcome.reason === "result"
		? { kind: "result", value: outcome.value }
		: { kind: "interrupted", reason: outcome.reason, uncertain: outcome.uncertain };
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
