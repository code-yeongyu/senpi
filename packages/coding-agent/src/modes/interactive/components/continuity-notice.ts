import type { AssistantMessage, AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import { theme } from "../theme/theme.ts";

export const CONTINUITY_DIAGNOSTIC_TYPE = "claude_sdk_oauth_session_continuity";
export const RESUME_FALLBACK_DIAGNOSTIC_TYPE = "claude_sdk_oauth_resume_fallback";

/** Only degradation kinds reach the transcript; healthy kinds stay in session.log and RPC. */
const DEGRADATION_KINDS = new Set(["flatten", "disabled"]);

/**
 * Rebuilds the user asked for or already accepted - not lost continuity. An
 * accepted compaction, a model switch, session-tree navigation and the
 * documented config-dir residual re-send the conversation by design, so they
 * must not read like the defect-shaped reasons (senpi#1976).
 */
export const EXPECTED_REBUILD_REASONS: ReadonlySet<string> = new Set([
	"tainted_compaction",
	"model_changed",
	"branch_diverged",
	"tainted_fork",
	"cross_root_unsupported",
]);

export type ContinuityReasonClass = "expected-rebuild" | "lost";

/** Classifies a flatten reason; a missing or unknown reason stays defect-shaped. */
export function classifyContinuityReason(reason: string | undefined): ContinuityReasonClass {
	return reason !== undefined && EXPECTED_REBUILD_REASONS.has(reason) ? "expected-rebuild" : "lost";
}

const REBUILT_LABEL = "Session context rebuilt";
const LOST_LABEL = "Session continuity lost - resent the full conversation";
const DISABLED_LABEL = "Session continuity disabled (resumeMode: off) - resending the conversation each turn";

/** The flatten label follows the reason's class (senpi#1976); disabled is static. */
function degradationLabel(kind: string, reason: string | undefined): string {
	if (kind === "disabled") return DISABLED_LABEL;
	return classifyContinuityReason(reason) === "expected-rebuild" ? REBUILT_LABEL : LOST_LABEL;
}

const RESUME_FALLBACK_LABEL = "Session continuity lost - resume failed, resent the full conversation";

type ContinuityDetails = {
	kind: string;
	reason?: string;
	payloadBytes?: number;
	collapsedDirectives?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

function continuityDetails(diagnostic: AssistantMessageDiagnostic): ContinuityDetails | undefined {
	if (diagnostic.type !== CONTINUITY_DIAGNOSTIC_TYPE) return undefined;
	const details = diagnostic.details;
	if (!details || typeof details.kind !== "string") return undefined;
	return {
		kind: details.kind,
		...(typeof details.reason === "string" ? { reason: details.reason } : {}),
		...(typeof details.payloadBytes === "number" ? { payloadBytes: details.payloadBytes } : {}),
		...(typeof details.collapsedDirectives === "number" ? { collapsedDirectives: details.collapsedDirectives } : {}),
		...(typeof details.cacheRead === "number" ? { cacheRead: details.cacheRead } : {}),
		...(typeof details.cacheWrite === "number" ? { cacheWrite: details.cacheWrite } : {}),
	};
}

/** Renders a byte count the way the transcript shows sizes: one decimal, KB/MB. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Appends the re-send cost to a degradation notice so the token bill is visible
 * at the moment it is paid: how much was resent, and how many duplicate
 * ultrawork directive blocks were collapsed out of it.
 */
function payloadSuffix(details: ContinuityDetails): string {
	if (details.payloadBytes === undefined) return "";
	const collapsed =
		details.collapsedDirectives !== undefined && details.collapsedDirectives > 0
			? `, ${details.collapsedDirectives} duplicate ultrawork blocks collapsed`
			: "";
	return ` - sent ${formatBytes(details.payloadBytes)}${collapsed}`;
}

/** Renders a token count like formatBytes, but truncated: a cost figure never rounds up. */
function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${Math.floor(tokens / 100) / 10}K`;
	return `${Math.floor(tokens / 100_000) / 10}M`;
}

/** Appends the cache cost when the diagnostic carried it (senpi#1976); only the known sides render. */
function cacheSuffix(details: ContinuityDetails): string {
	const read = details.cacheRead === undefined ? undefined : formatTokens(details.cacheRead);
	const write = details.cacheWrite === undefined ? undefined : formatTokens(details.cacheWrite);
	if (read !== undefined && write !== undefined) return ` - cache read ${read} / write ${write} tokens`;
	if (read !== undefined) return ` - cache read ${read} tokens`;
	if (write !== undefined) return ` - cache write ${write} tokens`;
	return "";
}

/**
 * Builds the muted single-line transcript notice for a completed assistant
 * message. `disabled` renders once per session so the escape hatch does not nag;
 * healthy kinds render nothing at all.
 */
export class ContinuityNoticeTracker {
	private renderedDisabled = false;

	/**
	 * Clear the suppression state. Called when the transcript is rebuilt
	 * (initial load, post-compaction rebuild, session switch): the rebuilt
	 * transcript re-derives notices from persisted messages, so the first
	 * disabled notice must be allowed to render again.
	 */
	reset(): void {
		this.renderedDisabled = false;
	}

	noticeFor(message: AssistantMessage): string | undefined {
		for (const diagnostic of message.diagnostics ?? []) {
			if (diagnostic.type === RESUME_FALLBACK_DIAGNOSTIC_TYPE) return this.format(RESUME_FALLBACK_LABEL);
			const details = continuityDetails(diagnostic);
			if (!details || !DEGRADATION_KINDS.has(details.kind)) continue;
			if (details.kind === "disabled") {
				if (this.renderedDisabled) continue;
				this.renderedDisabled = true;
			}
			const label = degradationLabel(details.kind, details.reason);
			const base = details.reason ? `${label} (${details.reason})` : label;
			return this.format(`${base}${payloadSuffix(details)}${cacheSuffix(details)}`);
		}
		return undefined;
	}

	private format(text: string): string {
		return theme.fg("muted", text);
	}
}
