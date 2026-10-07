/**
 * Provider-scoped compaction ownership for the `anthropic-subscription` main lane.
 *
 * That lane keeps one resident SDK session per senpi session. By default senpi
 * owns its compaction (speculative, idle, restoration, degradation recovery): an
 * accepted compaction invalidates the resident binding and the next turn
 * cold-seeds the compacted branch (`tainted_compaction` always flattens), while
 * the SDK's native auto-compact is pinned off so exactly one side compacts.
 *
 * `compactionOwner: "sdk"` opts out: the Claude Agent SDK runs its own native
 * auto-compaction over the resident transcript and senpi stands down for the
 * lane (no auto-compaction triggers, no context reduction). The stand-down lifts
 * with the `resumeMode: "off"` escape hatch, where senpi flattens its own
 * history into every request. Every other provider is untouched.
 *
 * The owner is read per call, from the same settings snapshot the query options
 * use for the next turn, so a mid-session change can never leave the two sides
 * disagreeing about who compacts.
 *
 * This module also owns the shape of the mirrored `compact_boundary` ledger
 * entry, so the SDK's native compactions stay visible in senpi history.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../../session-manager.ts";
import type { CompactionReason } from "../../types.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../anthropic-subscription/account-management.ts";
import { isColdSeedOverflowMessage } from "../anthropic-subscription/cold-seed-budget.ts";
import type { AnthropicSubscriptionProviderSettings } from "../anthropic-subscription/settings.ts";
import {
	loadAnthropicSubscriptionProviderSettingsFromDisk,
	resolveCompactionOwner,
} from "../anthropic-subscription/settings.ts";

/** Custom session entry type carrying a mirrored SDK compaction boundary. */
export const ANTHROPIC_SUBSCRIPTION_COMPACT_ENTRY_TYPE = "claude-sdk-oauth-compact";
/** Assistant-message diagnostic the lane uses to transport a received boundary. */
export const ANTHROPIC_SUBSCRIPTION_COMPACT_BOUNDARY_DIAGNOSTIC = "claude_sdk_oauth_compact_boundary";
/**
 * Reason reported when senpi declines to compact an SDK-native lane. The
 * `external-owner` rejection cause carries the machine-readable policy while
 * this string is what the user and the compaction log see.
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
	/** Resolved `anthropicSubscriptionProvider.compactionOwner`; `undefined` means the "senpi" default. */
	compactionOwner?: string;
}

export interface LaneContext {
	cwd: string;
	model: LaneModel | undefined;
	/**
	 * Optional resolved-settings getter (present on the real ExtensionContext).
	 * Used to read a configured `compaction.model` override. When an override is
	 * set the lane hands summarization to a senpi-owned model, so the SDK-native
	 * stand-down no longer applies even with a resident SDK session.
	 */
	getCompactionSettings?: () => { model?: string };
	/** Branch reader (present on the real ExtensionContext) used to find a failed cold-seed turn. */
	sessionManager?: { getBranch(): readonly SessionEntry[] };
}

export interface CompactionLanePolicy {
	/** True when the SDK owns this lane's context and senpi compaction must stand down. */
	disablesSenpiCompaction(context: LaneContext): boolean;
	/** Manual requests are explicitly owned by senpi for recovery, even on SDK lanes. */
	ownsCompaction(context: LaneContext, reason: CompactionReason): boolean;
	/**
	 * True when the active lane replays its transcript into a resident SDK session that
	 * only accepts appended messages. Per-turn history rewrites (no-LLM context reduction)
	 * would diverge it and force a full cold re-send every turn, so they must not run;
	 * compaction (one summary, one cold-seed) is the reduction path there.
	 */
	hasAppendOnlyTranscript(context: LaneContext): boolean;
}

export interface CompactBoundaryEntry {
	schema: typeof COMPACT_BOUNDARY_SCHEMA;
	sdkSessionId: string;
	uuid: string;
	compactMetadata: Record<string, unknown>;
}

/**
 * A cold-seed re-sends senpi's own history as one message the SDK cannot compact,
 * so an overflow of that request is senpi's to recover. Only the newest assistant
 * since the latest compaction counts: an already-compacted failure is settled.
 */
function lastTurnIsColdSeedOverflow(context: LaneContext): boolean {
	const branch = context.sessionManager?.getBranch() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "compaction") return false;
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return isColdSeedOverflowMessage(entry.message);
		}
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure lane predicate. Kept separate from {@link createCompactionLanePolicy} so
 * callers that already know the resolved resume mode never touch disk.
 */
export function isSdkNativeCompactionLane(input: SdkNativeLaneInput): boolean {
	if (input.model?.provider !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) return false;
	return input.compactionOwner === "sdk" && input.resumeMode !== "off";
}

/**
 * Per-extension-instance lane policy. Settings are only read when the active
 * model actually belongs to the lane, so other providers never pay for the
 * lookup; the loader itself is cached by settings-file revision.
 */
export function createCompactionLanePolicy(
	options: { loadProviderSettings?: (cwd: string) => AnthropicSubscriptionProviderSettings } = {},
): CompactionLanePolicy {
	const load = options.loadProviderSettings ?? loadAnthropicSubscriptionProviderSettingsFromDisk;
	// Read on every call, never memoized here: the query options re-read the same
	// settings for every turn, and a cached owner would let a mid-session change
	// leave senpi and the resident process disagreeing about who compacts. Returns
	// undefined when the settings cannot be read, so callers fail closed to
	// senpi's full behavior.
	const readProviderSettings = (cwd: string): AnthropicSubscriptionProviderSettings | undefined => {
		try {
			return load(cwd);
		} catch {
			return undefined;
		}
	};
	// Declared as a local so `ownsCompaction` never depends on `this`: the policy object
	// is routinely destructured at call sites, which would otherwise unbind the receiver.
	const disablesSenpiCompaction = (context: LaneContext): boolean => {
		if (context.model?.provider !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) return false;
		// A configured compaction model override makes senpi own summarization
		// for the lane, so the SDK-native stand-down no longer applies. This is
		// the escape hatch for lanes whose SDK never fires native compaction.
		if (context.getCompactionSettings?.().model) return false;
		// A settings read failure must never silently disable senpi compaction.
		const providerSettings = readProviderSettings(context.cwd);
		if (!providerSettings) return false;
		return isSdkNativeCompactionLane({
			model: context.model,
			resumeMode: providerSettings.resumeMode,
			compactionOwner: resolveCompactionOwner(providerSettings),
		});
	};
	return {
		disablesSenpiCompaction,
		hasAppendOnlyTranscript(context: LaneContext): boolean {
			if (context.model?.provider !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) return false;
			const providerSettings = readProviderSettings(context.cwd);
			if (!providerSettings) return false;
			return providerSettings.resumeMode !== "off";
		},
		ownsCompaction(context: LaneContext, reason: CompactionReason): boolean {
			// Manual is senpi-owned everywhere: it is the user's explicit recovery path,
			// including on an SDK-native lane whose automatic routes stay SDK-owned.
			if (reason === "manual" || !disablesSenpiCompaction(context)) return true;
			return reason === "overflow" && lastTurnIsColdSeedOverflow(context);
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
		if (diagnostic.type !== ANTHROPIC_SUBSCRIPTION_COMPACT_BOUNDARY_DIAGNOSTIC) continue;
		const entry = parseCompactBoundaryMessage(diagnostic.details);
		if (entry) entries.push(entry);
	}
	return entries;
}
