import { createHash, randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { type CompactionPreparation, type CompactionResult, estimateTokens } from "../../../compaction/index.ts";
import { admitCursorHistory, cursorAdmissionBudgetBytes } from "../../../cursor-history-admission.ts";
import { filterContextExcludedMessages } from "../../../messages.ts";
import {
	buildContextEntries,
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
} from "../../../session-manager.ts";
import { resolveEffectiveReserveTokens } from "./policy.ts";

export const REJECTED_RECOVERY_ENTRY = "compaction-recovery-rejected";

/** Shared with core admission: a fallback's conservative estimate cannot overrule a usable summary. */
export function wouldCompactionOverflow(
	pathEntries: SessionEntry[],
	compactionResult: CompactionResult,
	fromExtension: boolean,
	model: Model<string>,
	settings: CompactionPreparation["settings"],
): boolean {
	const currentLeaf = pathEntries.at(-1);
	if (!currentLeaf) return false;
	const simulatedCompactionEntry: CompactionEntry = {
		type: "compaction",
		id: `simulated-${randomUUID()}`,
		parentId: currentLeaf.id,
		timestamp: new Date().toISOString(),
		summary: compactionResult.summary,
		firstKeptEntryId: compactionResult.firstKeptEntryId,
		tokensBefore: compactionResult.tokensBefore,
		details: compactionResult.details,
		fromHook: fromExtension,
	};
	let messages = buildSessionContext([...pathEntries, simulatedCompactionEntry], simulatedCompactionEntry.id).messages;
	if (model.provider === "cursor" || model.provider === "cursor-cli-oauth") {
		messages =
			admitCursorHistory({
				messages,
				budgetBytes: cursorAdmissionBudgetBytes(model.contextWindow),
			}).messages ?? messages;
	}
	const tokens = filterContextExcludedMessages(messages).reduce(
		(total, message) => total + estimateTokens(message),
		0,
	);
	return tokens > model.contextWindow - resolveEffectiveReserveTokens(model.contextWindow, settings);
}

/** State, not elapsed time or a synthetic message revision, releases the latch. */
export function compactionRecoveryStateKey(
	branch: readonly SessionEntry[],
	model: Model<string> | undefined,
	settings: CompactionPreparation["settings"],
): string {
	const hash = createHash("sha256");
	hash.update(
		JSON.stringify({
			model: model && [model.provider, model.id, model.api, model.baseUrl, model.contextWindow],
			reserveTokens: settings.reserveTokens,
			reserveScalingEnabled: settings.reserveScalingEnabled,
			keepRecentTokens: settings.keepRecentTokens,
		}),
	);
	for (const entry of buildContextEntries([...branch])) {
		// Status/todo/usage bookkeeping is not a new retained context. In particular,
		// the rejection's own durable entry must not release its latch.
		if (
			entry.type !== "message" &&
			entry.type !== "custom_message" &&
			entry.type !== "compaction" &&
			entry.type !== "context_edit" &&
			entry.type !== "branch_summary" &&
			entry.type !== "configuration_update"
		)
			continue;
		// The resident mirror removes summarized messages and reconnects parent IDs.
		// Neither changes the retained context or its identities after reopen.
		hash.update(JSON.stringify({ ...entry, parentId: undefined }));
		hash.update("\n");
	}
	return hash.digest("hex");
}

/** Persisted on the branch, so extension reload and session reopen cannot retry it. */
export function isAutomaticCompactionBlocked(
	branch: readonly SessionEntry[],
	model: Model<string> | undefined,
	settings: CompactionPreparation["settings"],
): boolean {
	const rejection = branch.findLast(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === REJECTED_RECOVERY_ENTRY &&
			entry.data !== null &&
			typeof entry.data === "object" &&
			"failureKind" in entry.data &&
			entry.data.failureKind === "unsafe-retained-content",
	);
	if (rejection?.type !== "custom" || !rejection.data || typeof rejection.data !== "object") return false;
	return (
		"stateKey" in rejection.data && rejection.data.stateKey === compactionRecoveryStateKey(branch, model, settings)
	);
}
