import { type CompactionPreparation, type CompactionResult, estimateTokens } from "../../../compaction/index.ts";
import { StreamDurationBudgetError, StreamIdleTimeoutError } from "../../../compaction/stream-watchdog.ts";
import { filterContextExcludedMessages } from "../../../messages.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	getSessionContextEntryId,
	type SessionEntry,
} from "../../../session-manager.ts";
import { markFailedTurnFragments } from "./fallback-failed-turn-normalization.ts";
import { SummarizationOverflowExhaustedError } from "./overflow-retry.ts";
import { resolveEffectiveReserveTokens } from "./policy.ts";
import { hasUnsafeRetainedContent } from "./retained-message-safety.ts";
import { SummaryGenerationError, SummaryRequestError } from "./speculative.ts";
import { capUtf8Bytes } from "./task-intent.ts";

export type RequiredCompactionFallbackFailure =
	| "summarization-timeout"
	| "upstream-stream-truncated"
	| "summarization-overflow-exhausted"
	| "summarization-empty-summary";

interface RecoveryMetadata {
	taskIntent?: string;
	todoSnapshot?: unknown;
	checkpoint?: unknown;
}

export type DeterministicFallbackRejectionReason =
	| "missing-preparation-boundary"
	| "unsafe-retained-content"
	| "retained-token-budget-exceeded"
	| "atomic-tool-chain-cut"
	| "context-reconstruction-failed";

interface DeterministicFallbackDetails {
	schema: "senpi.compaction.deterministic-fallback.v1";
	origin: "required-compaction-recovery";
	failureKind: RequiredCompactionFallbackFailure;
	taskIntent?: string;
	retainedSuffix?: "prepared" | "latest-user-turn" | "earlier-safe-boundary";
}

export interface DeterministicFallbackDiagnostic {
	rejectionReason?: DeterministicFallbackRejectionReason;
	candidateRejections?: Array<{
		firstKeptEntryId: string;
		rejectionReason: DeterministicFallbackRejectionReason;
		estimatedTokens?: number;
		unsafeMessageIndex?: number;
		unsafeEntryId?: string;
		unsafeMessageRole?: string;
	}>;
	candidatesChecked?: number;
	budgetExceeded?: boolean;
	contextWindow?: number;
	reserveTokens?: number;
	budgetTokens?: number;
}

export function formatRequiredCompactionFallbackRejection(diagnostics: DeterministicFallbackDiagnostic): string {
	const candidate = diagnostics.candidateRejections?.at(-1);
	const reason = diagnostics.rejectionReason ?? "context-reconstruction-failed";
	const recovery: Record<DeterministicFallbackRejectionReason, string> = {
		"retained-token-budget-exceeded":
			"The retained turn exceeds the usable context. Select a model with a larger context and run /compact, or start a new session with an explicit checkpoint.",
		"atomic-tool-chain-cut":
			"The retained tool calls and results do not form complete pairs. Finish the pending tool operation before /compact; if the transcript is damaged, start a new session with an explicit checkpoint.",
		"unsafe-retained-content":
			"The retained message cannot be replayed safely. Inspect the identified entry; start a new session with an explicit checkpoint if it cannot be repaired.",
		"missing-preparation-boundary":
			"The prepared boundary is absent from the branch. Reload the session and run /compact.",
		"context-reconstruction-failed":
			"The retained context could not be reconstructed. Reload the session and run /compact.",
	};
	const diagnostic = {
		rejectionReason: reason,
		contextWindow: diagnostics.contextWindow,
		reserveTokens: diagnostics.reserveTokens,
		budgetTokens: diagnostics.budgetTokens,
		budgetExceeded: diagnostics.budgetExceeded ?? false,
		candidatesChecked: diagnostics.candidatesChecked ?? 0,
		...(candidate
			? {
					candidate: {
						...candidate,
						firstKeptEntryId: capUtf8Bytes(candidate.firstKeptEntryId, 128),
						...(candidate.unsafeEntryId ? { unsafeEntryId: capUtf8Bytes(candidate.unsafeEntryId, 128) } : {}),
						...(candidate.unsafeMessageRole
							? { unsafeMessageRole: capUtf8Bytes(candidate.unsafeMessageRole, 32) }
							: {}),
					},
				}
			: {}),
	};
	return `deterministic compaction fallback could not retain a safe suffix\n${JSON.stringify(diagnostic)}\n${recovery[reason]} The original transcript has not been changed.`;
}

const NON_VISIBLE_USER_TEXT = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasMeaningfulUserText(entry: SessionEntry): boolean {
	if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return false;
	const content = entry.message.content;
	const hasVisibleText = (text: unknown): boolean =>
		typeof text === "string" && text.normalize("NFKC").replace(NON_VISIBLE_USER_TEXT, "").length > 0;
	if (typeof content === "string") return hasVisibleText(content);
	if (!Array.isArray(content)) return false;
	return content.some((block) => isRecord(block) && block.type === "text" && hasVisibleText(block.text));
}

/**
 * Bound a value graph that came from persisted, potentially hostile session data.
 * Returns false when the graph contains anything we must not read (accessors,
 * non-plain prototypes, cycles, functions, symbols) so callers fail closed
 * instead of executing persisted code or walking unbounded structures.
 */
function isSafeBoundedValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
	if (depth > 32) return false;
	if (value === null || value === undefined) return true;
	const kind = typeof value;
	if (kind === "string" || kind === "number" || kind === "boolean") return true;
	if (kind !== "object") return false;
	if (seen.has(value as object)) return false;
	seen.add(value as object);
	if (Array.isArray(value)) {
		for (const item of value) if (!isSafeBoundedValue(item, seen, depth + 1)) return false;
		return true;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
		if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
		if (typeof descriptor.value === "function" || typeof descriptor.value === "symbol") return false;
		if (!isSafeBoundedValue(descriptor.value, seen, depth + 1)) return false;
	}
	return true;
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
	if (error instanceof SummaryGenerationError && error.kind === "empty-summary") {
		return "summarization-empty-summary";
	}
	return undefined;
}

export function createRequiredCompactionFallback(
	preparation: CompactionPreparation,
	contextWindow: number,
	failureKind: RequiredCompactionFallbackFailure,
	metadata: RecoveryMetadata,
	branchEntries: SessionEntry[] = [],
	diagnostics?: DeterministicFallbackDiagnostic,
): CompactionResult<DeterministicFallbackDetails> | undefined {
	const reserveTokens = resolveEffectiveReserveTokens(contextWindow, preparation.settings);
	const budget = contextWindow - reserveTokens;
	const preparedBoundaryIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
	if (!preparation.firstKeptEntryId || preparedBoundaryIndex === -1) {
		if (diagnostics) {
			Object.assign(diagnostics, {
				rejectionReason: "missing-preparation-boundary",
				contextWindow,
				reserveTokens,
				budgetTokens: budget,
			});
		}
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
	let candidateCount = 0;

	const syntheticCompaction: CompactionEntry = {
		type: "compaction",
		id: "__senpi_deterministic_fallback_preview__",
		parentId: branchEntries.at(-1)?.id ?? null,
		timestamp: new Date(0).toISOString(),
		summary,
		firstKeptEntryId: branchEntries[0]?.id ?? preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { ...baseDetails, retainedSuffix: "prepared" },
		fromHook: true,
	};

	let projectedMessages: ReturnType<typeof filterContextExcludedMessages>;
	try {
		projectedMessages = filterContextExcludedMessages(
			buildSessionContext([...branchEntries, syntheticCompaction]).messages,
		);
	} catch {
		if (diagnostics) {
			Object.assign(diagnostics, {
				rejectionReason: "context-reconstruction-failed",
				contextWindow,
				reserveTokens,
				budgetTokens: budget,
			});
		}
		return undefined;
	}

	// Evaluate the candidate the provider would actually receive: `convertToLlm`
	// drops failed/aborted assistant turns (and their orphaned tool results) before
	// every request, so their dangling toolCall blocks are neither incomplete calls
	// nor retained tokens here. Raw session history stays untouched - this mask is
	// local to the fallback projection (code-yeongyu/oh-my-openagent#7921).
	const droppedByFailedTurnNormalization = markFailedTurnFragments(projectedMessages);

	const messageIndexesByEntryId = new Map<string, number>();
	for (const [index, message] of projectedMessages.entries()) {
		const entryId = getSessionContextEntryId(message);
		if (entryId !== undefined) messageIndexesByEntryId.set(entryId, index);
	}
	const summaryIndex = messageIndexesByEntryId.get(syntheticCompaction.id);
	const unsafeSuffix = new Array(projectedMessages.length + 1).fill(false);
	const unsafeIndexSuffix = new Int32Array(projectedMessages.length + 1).fill(-1);
	const tokenSuffix = new Array(projectedMessages.length + 1).fill(0);
	const toolCalls = new Map<string, { indexes: number[]; newestIncomplete: boolean }>();
	const toolResults = new Map<string, number[]>();
	for (let index = projectedMessages.length - 1; index >= 0; index--) {
		const message = projectedMessages[index];
		tokenSuffix[index] = tokenSuffix[index + 1];
		unsafeIndexSuffix[index] = unsafeIndexSuffix[index + 1];
		if (droppedByFailedTurnNormalization[index]) {
			unsafeSuffix[index] = unsafeSuffix[index + 1];
			continue;
		}
		let messageUnsafe = false;
		let serialized: string | undefined;
		try {
			messageUnsafe = hasUnsafeRetainedContent([message]);
			const bounded = isSafeBoundedValue(message);
			messageUnsafe ||= !bounded;
			let imageTokens = 0;
			if (!messageUnsafe && message.role === "toolResult") {
				const content = message.content.map((block) => {
					if (block.type !== "image") return block;
					imageTokens += estimateTokens({ ...message, content: [block] });
					return { ...block, data: "" };
				});
				serialized = JSON.stringify({ ...message, content });
			} else {
				serialized = bounded ? JSON.stringify(message) : undefined;
			}
			// Apply the shared weighted chars/4 estimator to the envelope too.
			// Storage bytes are not tokens; opaque text and image costs still count.
			tokenSuffix[index] +=
				serialized === undefined
					? Number.POSITIVE_INFINITY
					: Math.max(
							estimateTokens(message),
							estimateTokens({ role: "user", content: serialized, timestamp: 0 }) + imageTokens,
						);
		} catch {
			messageUnsafe = true;
			tokenSuffix[index] = Number.POSITIVE_INFINITY;
		}
		unsafeSuffix[index] = unsafeSuffix[index + 1] || messageUnsafe;
		if (messageUnsafe) unsafeIndexSuffix[index] = index;
		if (!isRecord(message)) continue;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const indexes = toolResults.get(message.toolCallId) ?? [];
			indexes.push(index);
			toolResults.set(message.toolCallId, indexes);
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
				const call = toolCalls.get(block.id) ?? { indexes: [], newestIncomplete: block.incomplete === true };
				call.indexes.push(index);
				toolCalls.set(block.id, call);
			}
		}
	}
	const invalidToolChainDiff = new Int32Array(projectedMessages.length + 2);
	const markInvalidRange = (start: number, endExclusive: number) => {
		const boundedStart = Math.max(0, start);
		const boundedEnd = Math.min(projectedMessages.length + 1, endExclusive);
		if (boundedStart >= boundedEnd) return;
		invalidToolChainDiff[boundedStart]++;
		invalidToolChainDiff[boundedEnd]--;
	};
	for (const [id, call] of toolCalls) {
		const results = toolResults.get(id) ?? [];
		if (results.length === 0) {
			markInvalidRange(0, Math.max(call.indexes[0] ?? -1, results[0] ?? -1) + 1);
			continue;
		}
		const callIndex = call.indexes[0];
		const resultIndex = results[0];
		// Indexes are newest-first. Older duplicate IDs matter only while retained;
		// dropping an entire historical pair leaves the newest pair valid.
		markInvalidRange(0, Math.max(call.indexes[1] ?? -1, results[1] ?? -1) + 1);
		if (call.newestIncomplete || callIndex >= resultIndex) {
			markInvalidRange(0, Math.max(callIndex, resultIndex) + 1);
		} else {
			markInvalidRange(callIndex + 1, resultIndex + 1);
		}
	}
	for (const [id, results] of toolResults) {
		if (toolCalls.has(id)) continue;
		markInvalidRange(0, results[0] + 1);
	}
	const toolChainValidAt = new Array(projectedMessages.length + 1).fill(true);
	let invalidToolChainCount = 0;
	for (let index = 0; index < toolChainValidAt.length; index++) {
		invalidToolChainCount += invalidToolChainDiff[index];
		toolChainValidAt[index] = invalidToolChainCount === 0;
	}

	const projectCandidate = (
		firstKeptEntryId: string,
		retainedSuffix: NonNullable<DeterministicFallbackDetails["retainedSuffix"]>,
	): CompactionResult<DeterministicFallbackDetails> | undefined => {
		candidateCount++;
		const details = { ...baseDetails, retainedSuffix };
		const reject = (
			rejectionReason: DeterministicFallbackRejectionReason,
			detail: Omit<
				NonNullable<DeterministicFallbackDiagnostic["candidateRejections"]>[number],
				"firstKeptEntryId" | "rejectionReason"
			> = {},
		): undefined => {
			if (diagnostics) {
				diagnostics.rejectionReason = rejectionReason;
				diagnostics.contextWindow = contextWindow;
				diagnostics.reserveTokens = reserveTokens;
				diagnostics.budgetTokens = budget;
				diagnostics.candidateRejections ??= [];
				diagnostics.candidateRejections.push({ firstKeptEntryId, rejectionReason, ...detail });
			}
			return undefined;
		};
		const result: CompactionResult<DeterministicFallbackDetails> = {
			summary,
			firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details,
		};
		const startIndex = messageIndexesByEntryId.get(firstKeptEntryId);
		if (startIndex === undefined) return reject("context-reconstruction-failed");
		const retainedStart = Math.min(startIndex, projectedMessages.length);
		if (unsafeSuffix[retainedStart]) {
			const unsafeMessageIndex = unsafeIndexSuffix[retainedStart];
			const unsafeMessage = projectedMessages[unsafeMessageIndex];
			return reject("unsafe-retained-content", {
				unsafeMessageIndex,
				unsafeEntryId: getSessionContextEntryId(unsafeMessage),
				unsafeMessageRole: unsafeMessage.role,
			});
		}
		if (!toolChainValidAt[retainedStart]) return reject("atomic-tool-chain-cut");
		// The hard-limit valve reserves the scaled budget, so accepting against the raw
		// configured reserve would admit a context that valve immediately compacts again.
		const summaryTokens =
			summaryIndex === undefined
				? Number.POSITIVE_INFINITY
				: Math.max(
						estimateTokens(projectedMessages[summaryIndex]),
						estimateTokens({
							role: "user",
							content: JSON.stringify(projectedMessages[summaryIndex]),
							timestamp: 0,
						}),
					);
		const retainedTokens = (tokenSuffix[retainedStart] ?? Number.POSITIVE_INFINITY) + summaryTokens;
		if (retainedTokens > budget) {
			if (diagnostics) diagnostics.budgetExceeded = true;
			return reject("retained-token-budget-exceeded", { estimatedTokens: retainedTokens });
		}
		return { ...result, estimatedTokensAfter: retainedTokens };
	};

	// 1. Try prepared boundary
	const prepared = projectCandidate(preparation.firstKeptEntryId, "prepared");
	if (prepared) {
		if (diagnostics) diagnostics.candidatesChecked = candidateCount;
		return prepared;
	}

	// 2. If prepared boundary cut an atomic signed chain or was rejected, walk backward
	// to the actual chain boundary. The chain length is determined by the session.
	for (let index = preparedBoundaryIndex - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type === "compaction") break;
		// Only consider message turn starts or assistant call starts
		const earlier = projectCandidate(entry.id, "earlier-safe-boundary");
		if (earlier) {
			if (diagnostics) diagnostics.candidatesChecked = candidateCount;
			return earlier;
		}
	}

	// 3. Try latest meaningful user turn
	for (let index = branchEntries.length - 1; index > preparedBoundaryIndex; index--) {
		const entry = branchEntries[index];
		if (!hasMeaningfulUserText(entry)) continue;
		const latestUser = projectCandidate(entry.id, "latest-user-turn");
		if (latestUser) {
			if (diagnostics) diagnostics.candidatesChecked = candidateCount;
			return latestUser;
		}
		// A steering user message can occur inside a tool chain. Keep that request
		// and walk back to its declaring assistant instead of orphaning the result.
		for (let earlierIndex = index - 1; earlierIndex > preparedBoundaryIndex; earlierIndex--) {
			const earlierEntry = branchEntries[earlierIndex];
			if (earlierEntry.type === "compaction") break;
			const earlier = projectCandidate(earlierEntry.id, "earlier-safe-boundary");
			if (earlier) {
				if (diagnostics) diagnostics.candidatesChecked = candidateCount;
				return earlier;
			}
		}
		break;
	}

	if (diagnostics) diagnostics.candidatesChecked = candidateCount;
	return undefined;
}
