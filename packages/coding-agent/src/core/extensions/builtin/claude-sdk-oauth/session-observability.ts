import { getAgentDir } from "../../../../config.ts";
import { createSessionLogger, type SessionLogger } from "../../../session-log.ts";

/**
 * Per-turn continuity observability for the claude-sdk-oauth lane.
 *
 * Emission semantics: a decision is STAGED per attempt at its final outcome
 * point and EMITTED only when the auth-lane retain/discard wrapper retains that
 * attempt (auth-attempt.ts). A discarded attempt emits nothing, so every
 * completed turn yields exactly one observation; a turn where every attempt
 * fails yields one terminal error observation instead.
 */
export type ContinuityKind = "bootstrap" | "delta" | "reattach" | "fork" | "flatten" | "disabled";

/** Fixed vocabulary — arbitrary error text never reaches an observation. */
export type ContinuityReason =
	| "prefix_matched"
	| "registry_miss"
	| "idle_ttl"
	| "capacity"
	| "model_selected"
	| "thinking_level_selected"
	| "bound_account_token_expiring"
	| "account_changed"
	| "model_changed"
	| "toolset_changed"
	| "system_prompt_changed"
	| "assistant_stream_diverged"
	| "sent_stream_diverged"
	| "options_changed"
	| "history_rolled_back"
	| "assistant_rewritten"
	| "transcript_missing"
	| "cross_root_unsupported"
	| "branch_diverged"
	| "branch_boundary_unavailable"
	| "branch_resume"
	| "tainted_compaction"
	| "tainted_fork"
	| "tainted_abort"
	| "tainted_assistant_provenance_unverified"
	| "resume_initialization_failed"
	| "resume_initialization_aborted"
	| "resume_mode_off"
	| "query_failed"
	| "turn_attribution_failed"
	| "abort_timeout"
	| "extensions_removed"
	| "session_shutdown"
	| "other";

export type ContinuityObservation = {
	kind: ContinuityKind;
	reason: ContinuityReason;
	deltaMessages?: number;
};

export type ContinuityObservabilityBoundary = {
	emit: (observation: ContinuityObservation) => void;
	log: (event: string, data: Record<string, unknown>) => void;
};

const SANITIZED_REASONS = new Set<string>([
	"prefix_matched",
	"registry_miss",
	"idle_ttl",
	"capacity",
	"model_selected",
	"thinking_level_selected",
	"bound_account_token_expiring",
	"account_changed",
	"model_changed",
	"toolset_changed",
	"system_prompt_changed",
	"assistant_stream_diverged",
	"options_changed",
	"history_rolled_back",
	"assistant_rewritten",
	"transcript_missing",
	"cross_root_unsupported",
	"sent_stream_diverged",
	"branch_diverged",
	"branch_boundary_unavailable",
	"branch_resume",
	"tainted_compaction",
	"tainted_fork",
	"tainted_abort",
	"tainted_assistant_provenance_unverified",
	"resume_initialization_failed",
	"resume_initialization_aborted",
	"resume_mode_off",
	"query_failed",
	"turn_attribution_failed",
	"abort_timeout",
	"extensions_removed",
	"session_shutdown",
	"other",
]);

let cachedLogger: SessionLogger | undefined;

function sessionLogger(): SessionLogger {
	cachedLogger ??= createSessionLogger(getAgentDir());
	return cachedLogger;
}

const defaultBoundary: ContinuityObservabilityBoundary = {
	emit: () => {},
	log: (event, data) => sessionLogger().info(event, data),
};
let activeBoundary = defaultBoundary;

export function overrideContinuityObservabilityBoundary(override: Partial<ContinuityObservabilityBoundary>): void {
	activeBoundary = { ...defaultBoundary, ...override };
}

export function resetContinuityObservabilityBoundary(): void {
	activeBoundary = defaultBoundary;
}

/** Maps a fixed vocabulary member through, and anything else to a bucketed cause. */
export function sanitizeReason(value: unknown): ContinuityReason {
	const text = typeof value === "string" ? value : value instanceof Error ? value.message : "";
	if (SANITIZED_REASONS.has(text)) return text as ContinuityReason;
	const tainted = /^tainted:(.+)$/.exec(text);
	if (tainted) {
		const mapped = `tainted_${tainted[1]}`;
		if (SANITIZED_REASONS.has(mapped)) return mapped as ContinuityReason;
	}
	return sanitizeCloseCause(value);
}

/** Buckets arbitrary close/pump failures into the fixed close-cause vocabulary. */
export function sanitizeCloseCause(value: unknown): ContinuityReason {
	const text = typeof value === "string" ? value : value instanceof Error ? value.message : "";
	if (SANITIZED_REASONS.has(text)) return text as ContinuityReason;
	if (/did not terminate|interrupt failed/i.test(text)) return "abort_timeout";
	if (/user_message_uuid did not match|result arrived before replay claim|pre-replay buffer overflow/i.test(text)) {
		return "turn_attribution_failed";
	}
	if (/query ended before|Claude SDK OAuth query|Claude Code/i.test(text)) return "query_failed";
	return "other";
}

/**
 * Classifies the failure that ended a turn after every auth attempt failed.
 * Anything reaching here came out of the SDK query path, so an Error is a query
 * failure unless it matches a more specific bucket; the raw text never escapes.
 */
export function sanitizeTerminalFailure(value: unknown): ContinuityReason {
	const cause = sanitizeCloseCause(value);
	if (cause !== "other") return cause;
	return value instanceof Error ? "query_failed" : "other";
}

/**
 * One-shot pending close causes keyed by senpi session id. `closeSession`
 * records the cause here; the next admission consumes it so a first-turn
 * `registry_miss` is attributed to the real cause instead.
 */
const pendingCloseCauses = new Map<string, ContinuityReason>();
// Long-running processes can stage many closes: the map is FIFO-bounded so it
// cannot grow without limit. 256 pending causes per process is far beyond any
// realistic session count; the oldest entry is evicted first.
const PENDING_CLOSE_CAUSE_LIMIT = 256;

export function recordPendingCloseCause(senpiSessionId: string, reason: unknown): void {
	const cause = sanitizeReason(reason);
	// Delete first so a re-recorded cause moves to the newest position.
	pendingCloseCauses.delete(senpiSessionId);
	if (pendingCloseCauses.size >= PENDING_CLOSE_CAUSE_LIMIT) {
		const oldest = pendingCloseCauses.keys().next().value;
		if (oldest !== undefined) pendingCloseCauses.delete(oldest);
	}
	pendingCloseCauses.set(senpiSessionId, cause);
	activeBoundary.log("claude_sdk_oauth_session_close", { reason: cause });
}

/** Read the pending close cause WITHOUT consuming it (consumed at emit time). */
export function peekPendingCloseCause(senpiSessionId: string): ContinuityReason | undefined {
	return pendingCloseCauses.get(senpiSessionId);
}

export function consumePendingCloseCause(senpiSessionId: string): ContinuityReason | undefined {
	const cause = pendingCloseCauses.get(senpiSessionId);
	pendingCloseCauses.delete(senpiSessionId);
	return cause;
}

/**
 * Maps the continuity decision families onto the observation vocabulary:
 * incremental→delta, resume→fork, cold-seed→flatten.
 */
export function observeSessionSyncDecision(input: {
	kind: "incremental" | "resume" | "cold-seed";
	reason?: string;
	deltaMessages: number;
	firstTurn: boolean;
	senpiSessionId: string;
}): ContinuityObservation {
	if (input.kind === "incremental") {
		return { kind: "delta", reason: "prefix_matched", deltaMessages: input.deltaMessages };
	}
	if (input.kind === "resume") {
		const retainedCause =
			input.reason === "registry_miss" ? consumePendingCloseCause(input.senpiSessionId) : undefined;
		return {
			kind: "fork",
			reason: retainedCause ?? (input.reason === undefined ? "branch_resume" : sanitizeReason(input.reason)),
			deltaMessages: input.deltaMessages,
		};
	}
	// Peek, not consume: the staged observation is emitted only when the
	// auth-lane RETAINS this attempt. Consuming here would lose the cause when
	// the attempt is discarded; the emit path consumes it (session-stream.ts).
	const retained = input.reason === "registry_miss" ? peekPendingCloseCause(input.senpiSessionId) : undefined;
	const reason = retained ?? sanitizeReason(input.reason);
	return {
		kind: input.firstTurn && reason === "registry_miss" ? "bootstrap" : "flatten",
		reason,
		deltaMessages: input.deltaMessages,
	};
}

export type StagedContinuityDecision = {
	observation: ContinuityObservation;
	emit: () => void;
};

/** Stages an attempt's decision; `emit` fires only when the attempt is retained. */
export function stageContinuityDecision(
	observation: ContinuityObservation,
	onDecision?: (observation: ContinuityObservation) => void,
	beforeEmit?: () => void,
): StagedContinuityDecision {
	let emitted = false;
	return {
		observation,
		emit: () => {
			if (emitted) return;
			emitted = true;
			beforeEmit?.();
			emitContinuityObservation(observation, onDecision);
		},
	};
}

export function emitContinuityObservation(
	observation: ContinuityObservation,
	onDecision?: (observation: ContinuityObservation) => void,
): void {
	onDecision?.(observation);
	activeBoundary.emit(observation);
	activeBoundary.log("claude_sdk_oauth_session_continuity", {
		kind: observation.kind,
		reason: observation.reason,
		...(observation.deltaMessages === undefined ? {} : { count: observation.deltaMessages }),
	});
}
