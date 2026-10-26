/**
 * The runtime-identity handover operation (code-yeongyu/oh-my-openagent#10091): its phases, its bounds and the
 * legacy state an older client reads it as. A handover never closes this host's admission. It either publishes a
 * verified successor for NEW sessions within one bounded window while every existing session stays with its
 * owner, or it ends `migration_deferred` with the reason it may not overlap yet; it never waits for global idle.
 */

/**
 * `preparing` lasts until the publication's outcome: the candidate consuming the handoff's one-shot token IS the
 * publication, so the design's `ready_to_publish` and `publishing` are not reported apart from it.
 */
export type HandoverPhase =
	| "checking_eligibility"
	| "migration_deferred"
	| "preparing"
	| "draining"
	| "completed"
	| "completed_with_retained_sessions"
	| "rolled_back"
	| "recovery_required";

/** Why an update may not overlap the running generation now. Deferral never changes admission. */
export type DeferredReason = "legacy_attached_client" | "rollout_disabled";

/** The state a pre-#10091 client reads a handover as (`begin_handover` answers, `host status`). */
export type LegacyHandoverState = "handover_pending" | "handover_completed" | "handover_blocked";

/** From the request's receipt to a terminal admission outcome, whatever the phases in between take. */
export const HANDOVER_OUTCOME_BOUND_MS = 45_000;

/** After publication: a predecessor still holding work then is reported retained, never stopped. */
export const HANDOVER_DRAIN_SOFT_DEADLINE_MS = 10 * 60_000;

/** Phases an operation ends in. `recovery_required` is not one: the publication it waits on still settles it. */
export const SETTLED_PHASES: ReadonlySet<HandoverPhase> = new Set<HandoverPhase>([
	"migration_deferred",
	"completed",
	"completed_with_retained_sessions",
	"rolled_back",
]);

/** Phases after which the successor serves new sessions: an admission outcome has been reached. */
export const PUBLISHED_PHASES: ReadonlySet<HandoverPhase> = new Set<HandoverPhase>([
	"draining",
	"completed",
	"completed_with_retained_sessions",
]);

export function legacyHandoverState(phase: HandoverPhase): LegacyHandoverState {
	switch (phase) {
		case "checking_eligibility":
		case "preparing":
			return "handover_pending";
		case "draining":
		case "completed":
		case "completed_with_retained_sessions":
			return "handover_completed";
		case "migration_deferred":
		case "rolled_back":
		case "recovery_required":
			return "handover_blocked";
		default:
			return assertNever(phase);
	}
}

function assertNever(value: never): never {
	throw new Error(`unknown handover phase: ${String(value)}`);
}
