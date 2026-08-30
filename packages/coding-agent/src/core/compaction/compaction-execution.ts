import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import {
	buildSummarizationContext,
	type CacheFriendlySummaryOptions,
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionResult,
	cacheFriendlyContextFits,
	combineUsage,
	completeSummarization,
	createSummarizationOptions,
	generateSummaryWithUsage,
	getSummarizationFailure,
	type SummarizationStreamFn,
} from "./compaction.ts";
import { computeFileLists, contentTextForSummary, formatFileOperations, serializeConversation } from "./utils.ts";

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

const SOURCE_CONTEXT_TURN_PREFIX_SUMMARIZATION_PROMPT = `The final turn in the source conversation was too large to keep in full. Its SUFFIX (recent work) is retained.

The source conversation may also contain complete earlier turns for background. Summarize only the final, incomplete turn. It begins with the last user-role request before this instruction. Do not summarize earlier turns except for details needed to understand this final turn's prefix.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 * @param cacheFriendly - Active provider contexts and request settings for cache-friendly summarization
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	extraBody?: Record<string, unknown>,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	cacheFriendly?: CacheFriendlySummaryOptions,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// Generate summaries and merge into one
	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				extraBody,
				thinkingLevel,
				streamFn,
				env,
				transformContext,
				retry,
				callbacks,
				sessionId,
				{
					sourceContext: cacheFriendly?.sourceContext,
					requestOptions: cacheFriendly?.requestOptions,
				},
			);
			historyText = historyResult.text;
			historyUsage = historyResult.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			env,
			signal,
			extraBody,
			thinkingLevel,
			streamFn,
			transformContext,
			retry,
			callbacks,
			sessionId,
			{
				sourceContext: cacheFriendly?.turnPrefixSourceContext,
				requestOptions: cacheFriendly?.requestOptions,
			},
		);
		// Merge into single summary
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		// Just generate history summary
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			extraBody,
			thinkingLevel,
			streamFn,
			env,
			transformContext,
			retry,
			callbacks,
			sessionId,
			{
				sourceContext: cacheFriendly?.sourceContext,
				requestOptions: cacheFriendly?.requestOptions,
			},
		);
		summary = result.text;
		summaryUsage = result.usage;
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	extraBody?: Record<string, unknown>,
	thinkingLevel?: ThinkingLevel,
	streamFn?: SummarizationStreamFn,
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	cacheFriendly?: Pick<CacheFriendlySummaryOptions, "sourceContext" | "requestOptions">,
): Promise<{ text: string; usage: Usage }> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	let sourceContext = cacheFriendly?.sourceContext;
	if (
		sourceContext &&
		!cacheFriendlyContextFits(
			model,
			buildSummarizationContext(SOURCE_CONTEXT_TURN_PREFIX_SUMMARIZATION_PROMPT, sourceContext),
			maxTokens,
		)
	) {
		sourceContext = undefined;
	}
	let promptText: string;
	if (sourceContext) {
		promptText = SOURCE_CONTEXT_TURN_PREFIX_SUMMARIZATION_PROMPT;
	} else {
		const providerMessages = transformContext ? await transformContext(messages, signal) : messages;
		const llmMessages = convertToLlm(providerMessages);
		const conversationText = serializeConversation(llmMessages);
		promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	}

	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText, sourceContext),
		createSummarizationOptions(
			model,
			maxTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			extraBody,
			sessionId,
			sourceContext ? cacheFriendly?.requestOptions : undefined,
			sourceContext ? "short" : undefined,
		),
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Turn prefix summarization");
	if (failure) throw new Error(failure);
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Turn prefix summarization attempted to call a tool");
	}

	return {
		text: contentTextForSummary(response.content),
		usage: response.usage,
	};
}
