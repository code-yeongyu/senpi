/**
 * Provider-scoped compaction opt-out for the `claude-sdk-oauth` main lane.
 *
 * That lane keeps one resident SDK session per senpi session, and the Claude
 * Agent SDK runs its own native auto-compaction over that session's transcript.
 * Running senpi's compaction on top of it would rewrite a history senpi no
 * longer owns, so senpi stands down for the lane: no auto-compaction triggers,
 * no context reduction. Every other provider is untouched.
 *
 * The stand-down is conditional on the lane actually being resident: with the
 * `resumeMode: "off"` escape hatch senpi flattens its own history into every
 * request, so senpi's compaction must stay fully active there.
 *
 * This module also owns the shape of the mirrored `compact_boundary` ledger
 * entry, so the SDK's native compactions stay visible in senpi history.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "../claude-sdk-oauth/account-management.ts";
import type { ClaudeSdkOauthProviderSettings } from "../claude-sdk-oauth/settings.ts";
import { loadClaudeSdkOauthProviderSettingsFromDisk } from "../claude-sdk-oauth/settings.ts";

/** Custom session entry type carrying a mirrored SDK compaction boundary. */
export const CLAUDE_SDK_OAUTH_COMPACT_ENTRY_TYPE = "claude-sdk-oauth-compact";
/** Assistant-message diagnostic the lane uses to transport a received boundary. */
export const CLAUDE_SDK_OAUTH_COMPACT_BOUNDARY_DIAGNOSTIC = "claude_sdk_oauth_compact_boundary";
/**
 * Reason reported when senpi declines to compact an SDK-native lane. The
 * structured `rejectionCause` stays `cancelled-by-extension` (a closed union
 * shared with the RPC surface); this string is what the user and the compaction
 * log see.
 */
export const SDK_NATIVE_LANE_REJECTION_REASON = "the Claude Agent SDK owns compaction for this session";
const COMPACT_BOUNDARY_SCHEMA = "senpi.claude-sdk-oauth.compact-boundary.v1";

export interface LaneModel {
	provider?: string;
}

export interface SdkNativeLaneInput {
	model: LaneModel | undefined;
	/** Resolved `claudeSdkOauthProvider.resumeMode`; `undefined` means the "auto" default. */
	resumeMode?: string;
}

export interface LaneContext {
	cwd: string;
	model: LaneModel | undefined;
}

export interface CompactionLanePolicy {
	/** True when the SDK owns this lane's context and senpi compaction must stand down. */
	disablesSenpiCompaction(context: LaneContext): boolean;
}

export interface CompactBoundaryEntry {
	schema: typeof COMPACT_BOUNDARY_SCHEMA;
	sdkSessionId: string;
	uuid: string;
	compactMetadata: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure lane predicate. Kept separate from {@link createCompactionLanePolicy} so
 * callers that already know the resolved resume mode never touch disk.
 */
export function isSdkNativeCompactionLane(input: SdkNativeLaneInput): boolean {
	if (input.model?.provider !== CLAUDE_SDK_OAUTH_PROVIDER_ID) return false;
	return input.resumeMode !== "off";
}

/**
 * Per-extension-instance policy holding one memoized provider-settings read.
 * Settings are only read when the active model actually belongs to the lane, so
 * other providers never pay for the lookup.
 */
export function createCompactionLanePolicy(
	options: { loadProviderSettings?: (cwd: string) => ClaudeSdkOauthProviderSettings } = {},
): CompactionLanePolicy {
	const load = options.loadProviderSettings ?? loadClaudeSdkOauthProviderSettingsFromDisk;
	let cachedCwd: string | undefined;
	let cachedResumeMode: string | undefined;
	return {
		disablesSenpiCompaction(context: LaneContext): boolean {
			if (context.model?.provider !== CLAUDE_SDK_OAUTH_PROVIDER_ID) return false;
			// Per-cwd cache is the intended contract (pinned by lane-policy.test.ts):
			// resumeMode is read once per cwd. A mid-session switch takes effect on
			// the next cwd or session.
			if (cachedCwd !== context.cwd) {
				try {
					cachedResumeMode = load(context.cwd).resumeMode;
				} catch {
					// A settings read failure must never silently disable senpi compaction:
					// fail closed by keeping senpi's own compaction fully active.
					cachedCwd = undefined;
					return false;
				}
				cachedCwd = context.cwd;
			}
			return isSdkNativeCompactionLane({ model: context.model, resumeMode: cachedResumeMode });
		},
	};
}

/** Parse an SDK `compact_boundary` system message into the senpi ledger payload. */
export function parseCompactBoundaryMessage(value: unknown): CompactBoundaryEntry | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "system" || value.subtype !== "compact_boundary") return undefined;
	if (typeof value.session_id !== "string" || typeof value.uuid !== "string") return undefined;
	if (!isRecord(value.compact_metadata)) return undefined;
	return {
		schema: COMPACT_BOUNDARY_SCHEMA,
		sdkSessionId: value.session_id,
		uuid: value.uuid,
		compactMetadata: { ...value.compact_metadata },
	};
}

function messageDiagnostics(message: AgentMessage): readonly AssistantMessageDiagnostic[] {
	if (message.role !== "assistant") return [];
	const diagnostics = message.diagnostics;
	return Array.isArray(diagnostics) ? diagnostics : [];
}

/** Collect every compaction boundary the lane attached to a finalized message. */
export function collectCompactBoundaryEntries(message: AgentMessage): CompactBoundaryEntry[] {
	const entries: CompactBoundaryEntry[] = [];
	for (const diagnostic of messageDiagnostics(message)) {
		if (diagnostic.type !== CLAUDE_SDK_OAUTH_COMPACT_BOUNDARY_DIAGNOSTIC) continue;
		const entry = parseCompactBoundaryMessage(diagnostic.details);
		if (entry) entries.push(entry);
	}
	return entries;
}
