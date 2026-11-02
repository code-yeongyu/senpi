import { estimateTokens, findCutPoint } from "../../../compaction/compaction.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../../../session-manager.ts";
import type { ModelUsabilityBudgetProjection } from "./model-usability-budget.ts";

export const RESUME_SLICE_SCHEMA = "senpi.compaction.resume-slice.v1";
export const RESUME_SLICE_ORIGIN = "resume-admission";

const PREVIEW_ENTRY_ID = "__senpi_resume_slice_preview__";
const MIN_KEEP_TOKENS = 1_024;
const MAX_CARRIED_SUMMARY_CHARS = 8_000;
const TRUNCATION_NOTE = "\n[Earlier checkpoint truncated]";

const CHECKPOINT_MARKER = [
	"[Resume recovery checkpoint]",
	"The restored conversation was larger than this model's context window, so older context was reduced without any provider request.",
	"The complete transcript is still recorded in the session file. Continue from the retained messages and treat omitted details as unknown.",
].join("\n");

export interface ResumeSlicePlan {
	readonly firstKeptEntryId: string;
	readonly summary: string;
	readonly tokensBefore: number;
	readonly tokensAfter: number;
	readonly droppedEntries: number;
}

export interface ResumeSliceInput {
	readonly entries: readonly SessionEntry[];
	readonly projection: ModelUsabilityBudgetProjection;
}

export function resumeSliceNotice(plan: ResumeSlicePlan): string {
	return `Restored context of ${plan.tokensBefore} tokens exceeded this model's window, so older context was reduced to ${plan.tokensAfter} tokens before the first prompt. The full transcript is preserved in the session file.`;
}

function fixedOverheadTokens(projection: ModelUsabilityBudgetProjection): number {
	return (
		projection.systemPromptTokens +
		projection.activeToolSchemaTokens +
		projection.outputReserveTokens +
		projection.compactionReserveTokens +
		projection.speculationLeadTokens +
		projection.safetyMarginTokens
	);
}

function latestCompaction(entries: readonly SessionEntry[]): CompactionEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction") return entry;
	}
	return undefined;
}

function resolveBoundaryStart(entries: readonly SessionEntry[]): number {
	const previous = latestCompaction(entries);
	if (!previous) return 0;
	const keptIndex = entries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
	if (keptIndex >= 0) return keptIndex;
	return entries.indexOf(previous) + 1;
}

function buildSliceSummary(entries: readonly SessionEntry[]): string {
	const carried = latestCompaction(entries)?.summary?.trim();
	if (!carried) return CHECKPOINT_MARKER;
	const bounded =
		carried.length <= MAX_CARRIED_SUMMARY_CHARS
			? carried
			: `${carried.slice(0, MAX_CARRIED_SUMMARY_CHARS - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
	return `${CHECKPOINT_MARKER}\n\nEarlier checkpoint:\n${bounded}`;
}

function measureSlicedContext(
	entries: readonly SessionEntry[],
	firstKeptEntryId: string,
	summary: string,
	tokensBefore: number,
): number {
	const preview: CompactionEntry = {
		type: "compaction",
		id: PREVIEW_ENTRY_ID,
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date(0).toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore,
		fromHook: false,
	};
	return buildSessionContext([...entries, preview], PREVIEW_ENTRY_ID).messages.reduce(
		(total, message) => total + estimateTokens(message),
		0,
	);
}

/**
 * Choose the smallest deterministic context reduction that lets an over-window
 * restored session carry an ordinary request. `findCutPoint` owns boundary
 * safety, so a retained tool result always keeps its originating tool call.
 */
export function planResumeSlice({ entries, projection }: ResumeSliceInput): ResumeSlicePlan | undefined {
	const overhead = fixedOverheadTokens(projection);
	const keepBudget = projection.contextWindow - overhead;
	if (keepBudget < MIN_KEEP_TOKENS) return undefined;

	const entryList = [...entries];
	const boundaryStart = resolveBoundaryStart(entryList);
	const summary = buildSliceSummary(entryList);
	let measuredCutIndex = -1;

	for (let target = keepBudget; target >= MIN_KEEP_TOKENS; target = Math.floor(target / 2)) {
		const cut = findCutPoint(entryList, boundaryStart, entryList.length, target);
		if (cut.firstKeptEntryIndex === measuredCutIndex) continue;
		measuredCutIndex = cut.firstKeptEntryIndex;
		const firstKeptEntryId = entryList[cut.firstKeptEntryIndex]?.id;
		if (!firstKeptEntryId) continue;
		const tokensAfter = measureSlicedContext(entryList, firstKeptEntryId, summary, projection.liveContextTokens);
		if (tokensAfter + overhead > projection.contextWindow) continue;
		return {
			firstKeptEntryId,
			summary,
			tokensBefore: projection.liveContextTokens,
			tokensAfter,
			droppedEntries: Math.max(0, cut.firstKeptEntryIndex - boundaryStart),
		};
	}
	return undefined;
}
