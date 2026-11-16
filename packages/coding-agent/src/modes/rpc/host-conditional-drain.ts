import { sessionQuestionBridges } from "./connection-question-bridge.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import { selectDrainVerdicts } from "./session-drain.ts";
import { holdUnattendedTurns } from "./session-drain-hold.ts";
import type { RouterContext } from "./session-router-context.ts";

export interface ConditionalDrainCommand {
	readonly type: "drain_if_idle";
	readonly id?: string;
	readonly admissionId?: string;
	readonly instanceId: string;
}

export type ConditionalDrainRefusal = "unknown_owner" | "drain_unsupported" | "host_busy" | "host_attached";
export type ConditionalDrainDecision =
	| { readonly action: "drained" }
	| { readonly action: "refuse"; readonly reason: ConditionalDrainRefusal };

/**
 * The child owns this transaction. No await, announcement, file write or hold precedes the verdict.
 * The router and automatic-turn gates close before the caller closes transport admission and announces.
 */
export function closeIdleDrainAdmission(host: RouterContext, instanceId: string): ConditionalDrainDecision {
	const refuse = (reason: ConditionalDrainRefusal): ConditionalDrainDecision => ({ action: "refuse", reason });
	if (instanceId !== (host.defaults.hostContext?.host_instance ?? hostInstanceId())) return refuse("unknown_owner");
	if (
		host.draining ||
		host.drainExitRequested ||
		host.activeRequests.size > 0 ||
		host.opensInFlight > 0 ||
		host.opensByConnection.size > 0 ||
		host.finalizations.size > 0 ||
		host.parks.size > 0
	)
		return refuse("host_busy");
	const rows = host.registry.list();
	let activityReadable = true;
	const verdicts = selectDrainVerdicts(
		host.registry,
		() => false,
		() => {
			activityReadable = false;
		},
	);
	if (!activityReadable || verdicts.park.length + verdicts.gone.length !== rows.length) return refuse("host_busy");
	for (const row of rows) {
		const entry = host.registry.peek(row.sessionId);
		const session = entry?.runtime?.session;
		if (
			(host.bindings.get(row.sessionId)?.pendingPrompts?.().length ?? 0) > 0 ||
			host.writer.pendingQuestionCount(row.sessionId) > 0 ||
			(session !== undefined && (sessionQuestionBridges.get(session)?.pendingQuestions().length ?? 0) > 0) ||
			(entry?.worker?.snapshot?.state.pendingQuestions?.length ?? 0) > 0
		)
			return refuse("host_busy");
	}
	if (rows.some((row) => row.attachments > 0)) return refuse("host_attached");
	// An isolate's last snapshot cannot prove it stayed idle until this host's admission closed.
	// Fail closed rather than park an automatic turn that started in that unseen interval.
	if (rows.some((row) => host.registry.peek(row.sessionId)?.worker !== undefined)) return refuse("drain_unsupported");
	host.conditionalDrain = true;
	host.draining = true;
	holdUnattendedTurns(host);
	return { action: "drained" };
}
