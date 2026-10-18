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

type ContinuityDetails = {
	kind: string;
	reason?: string;
	payloadBytes?: number;
	collapsedDirectives?: number;
	settingSource?: string;
};

const SETTING_SOURCE_LABELS: Readonly<Record<string, string>> = {
	env: "SENPI_CLAUDE_SDK_OAUTH_RESUME",
	project: "project settings",
	global: "global settings",
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
		...(typeof details.settingSource === "string" ? { settingSource: details.settingSource } : {}),
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
				// Only the resumeMode setting disables resume; a request with no session (registry_miss) is not a degradation.
				if (details.reason !== undefined && details.reason !== "resume_mode_off") continue;
				if (this.renderedDisabled) continue;
				this.renderedDisabled = true;
				const where =
					details.settingSource === undefined ? undefined : SETTING_SOURCE_LABELS[details.settingSource];
				if (where !== undefined) {
					return this.format(
						`Session continuity disabled (resumeMode: off, set by ${where}) - resending the conversation each turn${payloadSuffix(details)}`,
					);
				}
			}
			const label = KIND_LABELS[details.kind] ?? "Session continuity degraded";
			const base = details.reason ? `${label} (${details.reason})` : label;
			return this.format(`${base}${payloadSuffix(details)}`);
		}
		return undefined;
	}

	private format(text: string): string {
		return theme.fg("muted", text);
	}
}
