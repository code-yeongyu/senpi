import type { AssistantMessage, AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import { theme } from "../theme/theme.ts";

export const CONTINUITY_DIAGNOSTIC_TYPE = "claude_sdk_oauth_session_continuity";
export const RESUME_FALLBACK_DIAGNOSTIC_TYPE = "claude_sdk_oauth_resume_fallback";

/** Only degradation kinds reach the transcript; healthy kinds stay in session.log and RPC. */
const DEGRADATION_KINDS = new Set(["flatten", "disabled"]);

const KIND_LABELS: Readonly<Record<string, string>> = {
	flatten: "Session continuity lost - resent the full conversation",
	disabled: "Session continuity disabled (resumeMode: off) - resending the conversation each turn",
};

const RESUME_FALLBACK_LABEL = "Session continuity lost - resume failed, resent the full conversation";

function continuityDetails(diagnostic: AssistantMessageDiagnostic): { kind: string; reason?: string } | undefined {
	if (diagnostic.type !== CONTINUITY_DIAGNOSTIC_TYPE) return undefined;
	const details = diagnostic.details;
	if (!details || typeof details.kind !== "string") return undefined;
	return { kind: details.kind, reason: typeof details.reason === "string" ? details.reason : undefined };
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
			const label = KIND_LABELS[details.kind] ?? "Session continuity degraded";
			return this.format(details.reason ? `${label} (${details.reason})` : label);
		}
		return undefined;
	}

	private format(text: string): string {
		return theme.fg("muted", text);
	}
}
