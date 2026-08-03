import { type CompactionPreparation, type CompactionResult, estimateContextTokens } from "../../../compaction/index.ts";
import { StreamDurationBudgetError, StreamIdleTimeoutError } from "../../../compaction/stream-watchdog.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../../../session-manager.ts";
import { SummarizationOverflowExhaustedError } from "./overflow-retry.ts";
import { SummaryRequestError } from "./speculative.ts";
import { capUtf8Bytes } from "./task-intent.ts";

export type RequiredCompactionFallbackFailure =
	| "summarization-timeout"
	| "upstream-stream-truncated"
	| "summarization-overflow-exhausted";

interface RecoveryMetadata {
	taskIntent?: string;
	todoSnapshot?: unknown;
	checkpoint?: unknown;
}

interface DeterministicFallbackDetails {
	schema: "senpi.compaction.deterministic-fallback.v1";
	origin: "required-compaction-recovery";
	failureKind: RequiredCompactionFallbackFailure;
	retainedSuffix?: "prepared";
}

export function classifyRequiredCompactionFallbackFailure(
	error: unknown,
): RequiredCompactionFallbackFailure | undefined {
	if (error instanceof StreamDurationBudgetError || error instanceof StreamIdleTimeoutError) {
		return "summarization-timeout";
	}
	if (error instanceof SummaryRequestError && error.transient && error.failureKind === "upstream-stream-truncated") {
		return "upstream-stream-truncated";
	}
	if (error instanceof SummarizationOverflowExhaustedError) {
		return "summarization-overflow-exhausted";
	}
	return undefined;
}

export function createRequiredCompactionFallback(
	preparation: CompactionPreparation,
	contextWindow: number,
	failureKind: RequiredCompactionFallbackFailure,
	metadata: RecoveryMetadata,
	branchEntries: SessionEntry[] = [],
): CompactionResult<DeterministicFallbackDetails> | undefined {
	if (!preparation.firstKeptEntryId || !branchEntries.some((entry) => entry.id === preparation.firstKeptEntryId)) {
		return undefined;
	}

	const marker = [
		"[Deterministic compaction recovery checkpoint]",
		"Generated summarization did not complete, so older context was reduced without another provider request.",
		"Continue from the retained messages after this checkpoint. Treat omitted transcript details as unknown.",
	].join("\n");
	const taskIntent = metadata.taskIntent?.trim();
	const fixedText = taskIntent ? `${marker}\n\nTask intent:\n${taskIntent}` : marker;
	const maxSummaryBytes = Math.max(1_024, Math.floor(contextWindow * 0.4));
	const previousSummary = preparation.previousSummary?.trim();
	let summary = fixedText;
	if (previousSummary) {
		const availableBytes = Math.max(0, maxSummaryBytes - Buffer.byteLength(`${fixedText}\n\nPrevious checkpoint:\n`));
		const truncationMarker = "\n[Older checkpoint truncated]";
		const boundedPrevious =
			Buffer.byteLength(previousSummary) <= availableBytes
				? previousSummary
				: `${capUtf8Bytes(previousSummary, Math.max(0, availableBytes - Buffer.byteLength(truncationMarker)))}${truncationMarker}`;
		summary = `${fixedText}\n\nPrevious checkpoint:\n${boundedPrevious}`;
	}

	const baseDetails: DeterministicFallbackDetails = {
		schema: "senpi.compaction.deterministic-fallback.v1",
		origin: "required-compaction-recovery",
		failureKind,
		...(taskIntent ? { taskIntent } : {}),
	};
	const result: CompactionResult<DeterministicFallbackDetails> = {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: baseDetails,
	};
	const syntheticCompaction: CompactionEntry = {
		type: "compaction",
		id: "__senpi_deterministic_fallback_preview__",
		parentId: branchEntries.at(-1)?.id ?? null,
		timestamp: new Date(0).toISOString(),
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		details: result.details,
		fromHook: true,
	};
	const retainedTokens = estimateContextTokens(
		buildSessionContext([...branchEntries, syntheticCompaction]).messages,
	).tokens;
	if (retainedTokens > contextWindow - preparation.settings.reserveTokens) return undefined;
	return {
		...result,
		estimatedTokensAfter: retainedTokens,
		details: { ...baseDetails, retainedSuffix: "prepared" },
	};
}
