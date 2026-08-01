import { type CompactionPreparation, type CompactionResult, estimateContextTokens } from "../../../compaction/index.ts";
import { StreamDurationBudgetError, StreamIdleTimeoutError } from "../../../compaction/stream-watchdog.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../../../session-manager.ts";
import { SummaryRequestError } from "./speculative.ts";
import { capUtf8Bytes, sanitizeTaskIntent } from "./task-intent.ts";

export type RequiredCompactionFallbackFailure = "summarization-timeout" | "upstream-stream-truncated";

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

const TODO_RECOVERY_BYTE_CAP = 8_192;
const USER_INTENT_BYTE_CAP = 4_096;
const USER_MESSAGE_BYTE_CAP = 1_024;
const MAX_RECENT_USER_MESSAGES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function latestTodoItems(snapshot: unknown): unknown[] {
	if (!isRecord(snapshot) || !Array.isArray(snapshot.todos)) return [];
	const todos = snapshot.todos;
	for (let index = todos.length - 1; index >= 0; index -= 1) {
		const candidate = todos[index];
		if (!isRecord(candidate) || candidate.type !== "custom" || !isRecord(candidate.data)) continue;
		if (Array.isArray(candidate.data.phases)) return candidate.data.phases;
		if (Array.isArray(candidate.data.todos)) return candidate.data.todos;
	}
	return todos;
}

function formatTodoItem(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const content =
		typeof value.content === "string"
			? value.content.trim()
			: typeof value.text === "string"
				? value.text.trim()
				: "";
	if (!content) return undefined;
	const status = typeof value.status === "string" && value.status.trim() ? value.status.trim() : "pending";
	return `[${status}] ${content}`;
}

function formatTodoRecovery(snapshot: unknown): string | undefined {
	const lines: string[] = [];
	for (const item of latestTodoItems(snapshot)) {
		if (isRecord(item) && typeof item.name === "string" && Array.isArray(item.tasks)) {
			const tasks = item.tasks.flatMap((task) => {
				const formatted = formatTodoItem(task);
				return formatted ? [`- ${formatted}`] : [];
			});
			if (tasks.length > 0) lines.push(`${item.name.trim() || "Tasks"}:`, ...tasks);
			continue;
		}
		const formatted = formatTodoItem(item);
		if (formatted) lines.push(`- ${formatted}`);
	}
	if (lines.length === 0) return undefined;
	return capUtf8Bytes(lines.join("\n"), TODO_RECOVERY_BYTE_CAP);
}

function appendBoundedSection(base: string, heading: string, value: string | undefined, maxBytes: number): string {
	if (!value) return base;
	const prefix = `\n\n${heading}:\n`;
	const availableBytes = Math.max(0, maxBytes - Buffer.byteLength(`${base}${prefix}`));
	if (availableBytes === 0) return base;
	const bounded = capUtf8Bytes(value, availableBytes);
	return bounded ? `${base}${prefix}${bounded}` : base;
}

function readUserText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	const text =
		typeof content === "string"
			? content
			: content
					.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
					.join("\n");
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("<system-reminder>") || trimmed.startsWith("<omo-senpi-task>")) {
		return undefined;
	}
	return capUtf8Bytes(sanitizeTaskIntent(trimmed), USER_MESSAGE_BYTE_CAP);
}

function resolveDroppedUserIntent(branchEntries: SessionEntry[], firstKeptEntryId: string): string | undefined {
	const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (firstKeptIndex <= 0) return undefined;
	const recent: string[] = [];
	for (let index = firstKeptIndex - 1; index >= 0 && recent.length < MAX_RECENT_USER_MESSAGES; index -= 1) {
		const text = readUserText(branchEntries[index]!);
		if (text) recent.push(text);
	}
	if (recent.length === 0) return undefined;
	return capUtf8Bytes(recent.reverse().join("\n\n"), USER_INTENT_BYTE_CAP);
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
	const explicitTaskIntent = metadata.taskIntent?.trim();
	const taskIntent = explicitTaskIntent
		? capUtf8Bytes(sanitizeTaskIntent(explicitTaskIntent), USER_INTENT_BYTE_CAP)
		: resolveDroppedUserIntent(branchEntries, preparation.firstKeptEntryId);
	const maxSummaryBytes = Math.max(1_024, Math.floor(contextWindow * 0.4));
	let fixedText = appendBoundedSection(marker, "Task intent", taskIntent, maxSummaryBytes);
	fixedText = appendBoundedSection(
		fixedText,
		"Current todo state",
		formatTodoRecovery(metadata.todoSnapshot),
		maxSummaryBytes,
	);
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
