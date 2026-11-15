import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	AgentActivityOutcome,
	BeforeAgentStartEvent,
	BoundaryContextPreview,
	InputAttribution,
	InputDispositionEvent,
	SessionBoundaryDraft,
} from "../../core/extensions/types.ts";
import type { ExtensionRunner } from "../../core/extensions/runner.ts";
import type { BuildSystemPromptOptions } from "../../core/system-prompt.ts";
import {
	imagesOf,
	isBoolean,
	isNullableString,
	isNumber,
	isOneOf,
	isOptional,
	isRecord,
	isString,
	isStrings,
	type LoopHookDispatch,
	type LoopHookParseContext,
	loopHookFamily,
	malformed,
	forwarded,
} from "./loop-hook-payloads.ts";
import {
	editableContentSchema,
	isAgentMessage,
	isAgentMessages,
	isCount,
	userContentSchema,
} from "./agent-message-schema.ts";
import { INPUT_SOURCES, isSessionEntry } from "./session-entry-schema.ts";

// A hosted loop's turn (senpi#5898): its input and the start of the agent run, each turn's start, and the
// two boundaries that may append session entries and ask for one more request (`turn_end`, `agent_before_settle`).

const INPUT_ATTRIBUTIONS = ["user", "agent"] as const satisfies readonly InputAttribution[];
const STREAMING_BEHAVIORS = ["steer", "followUp"] as const;
const TRIGGERS = ["prompt", "delivery", "extension"] as const satisfies readonly BeforeAgentStartEvent["trigger"][];
const DISPOSITIONS = [
	"handled",
	"queued",
	"started",
	"rejected",
] as const satisfies readonly InputDispositionEvent["disposition"][];
const OUTCOMES = ["completed", "aborted", "error"] as const satisfies readonly AgentActivityOutcome[];
const DRAFT_TYPES = [
	"custom",
	"custom_message",
	"context_edit",
	"compaction",
] as const satisfies readonly SessionBoundaryDraft["type"][];

/** A session draft a boundary handler returned, checked by its type (the loop validates it against its session). */
function isDraft(value: unknown): value is SessionBoundaryDraft {
	if (!isRecord(value) || !isOneOf(value.type, DRAFT_TYPES)) return false;
	switch (value.type) {
		case "custom":
			return isString(value.customType);
		case "custom_message":
			return (
				isString(value.customType) && userContentSchema.safeParse(value.content).success && isBoolean(value.display)
			);
		case "context_edit":
			return (
				isString(value.targetId) &&
				(value.replacement === null ||
					(isRecord(value.replacement) && editableContentSchema.safeParse(value.replacement.content).success))
			);
		case "compaction":
			return isString(value.summary) && isNullableString(value.firstKeptEntryId);
	}
}

const LLM_ROLES = ["user", "assistant", "toolResult", "system", "configurationUpdate"] as const;

const isPreview = (value: unknown): value is BoundaryContextPreview =>
	isRecord(value) &&
	Array.isArray(value.contextEntries) &&
	value.contextEntries.every(
		(entry) => isRecord(entry) && isSessionEntry(entry.sourceEntry) && isAgentMessages(entry.messages),
	) &&
	isAgentMessages(value.contextMessages) &&
	isAgentMessages(value.llmMessages) &&
	value.llmMessages.every((message) => isOneOf(message.role, LLM_ROLES)) &&
	isAgentMessages(value.pendingMessages) &&
	isBoolean(value.canContinue);

const isToolResults = (value: unknown): value is ToolResultMessage[] =>
	Array.isArray(value) && value.every((message) => isAgentMessage(message) && message.role === "toolResult");

/**
 * A boundary step (review L2): the state the loop holds (its drafts, decision and `context` preview), `from`, the first
 * handler of the walk to run, and `walk`, the id of the walk a later step resumes (review L8, `loop-hook-boundary-walks`).
 * The hand's handlers chain their drafts and decision as a session's do, but only the loop can build the preview from
 * drafts, so the hand stops after a handler that returns drafts and its reply names `resume { next, extensionPath,
 * walk }`. The loop then does what a local `emitBoundary` does after that handler: rebuilds the preview, reports a
 * failed build against `extensionPath` (keeping the last good preview; the boundary ends with no drafts if they are
 * still invalid at its end), and forwards the event again with `from: next` and the same `walk`. A reply without
 * `resume` ends the hand's part of the walk. A first step has neither `from` nor `walk`; a step naming a walk this hand
 * does not hold open (a new hand process) is refused, and the loop starts the boundary over.
 */
function boundaryOf(event: "turn_end" | "agent_before_settle", payload: Record<string, unknown>) {
	const { outcome, entries, context, from, walk } = payload;
	const next = payload.continue;
	if (!isOneOf(outcome, OUTCOMES) || !Array.isArray(entries) || !entries.every(isDraft) || !isBoolean(next))
		throw malformed(event);
	if (!isPreview(context) || !isOptional(from, isCount) || !isOptional(walk, isString)) throw malformed(event);
	if ((from === undefined || from === 0) !== (walk === undefined)) throw malformed(event);
	return { outcome, entries, next, context, from: from ?? 0, walk };
}

const steppedBoundary =
	(
		base: Parameters<ExtensionRunner["emitBoundary"]>[0],
		step: ReturnType<typeof boundaryOf>,
		{ sessionId, walks }: LoopHookParseContext,
	) =>
	async ({ runner, only }: LoopHookDispatch) => {
		const walk =
			step.walk === undefined
				? runner.openBoundaryWalk(base.type, only)
				: walks.resume(sessionId, step.walk, step.from);
		const id = step.walk ?? walks.open(sessionId, walk);
		const forwarded = { walk, from: step.from, entries: step.entries, continue: step.next };
		let result: Awaited<ReturnType<ExtensionRunner["emitBoundary"]>>;
		try {
			result = await runner.emitBoundary(base, () => step.context, forwarded);
		} catch (error) {
			walks.release(sessionId, id);
			throw error;
		}
		if (result.resume === undefined) walks.close(sessionId, id);
		else walks.advance(sessionId, id, result.resume.next);
		return {
			entries: result.entries,
			continue: result.continue,
			...(result.resume === undefined ? {} : { resume: { ...result.resume, walk: id } }),
		};
	};

export const TURN_LOOP_HOOKS = loopHookFamily({
	input: (payload) => {
		const { inputId, text, source, attribution, streamingBehavior } = payload;
		const images = imagesOf(payload.images);
		if (
			!isString(inputId) ||
			!isString(text) ||
			images === null ||
			!isOneOf(source, INPUT_SOURCES) ||
			!isOneOf(attribution, INPUT_ATTRIBUTIONS) ||
			!(streamingBehavior === undefined || isOneOf(streamingBehavior, STREAMING_BEHAVIORS))
		)
			throw malformed("input");
		return {
			emit: ({ runner, only }) =>
				runner.emitInput(text, images, source, streamingBehavior, inputId, attribution, only),
		};
	},
	input_disposition: ({ inputId, disposition }) => {
		if (!isString(inputId) || !isOneOf(disposition, DISPOSITIONS)) throw malformed("input_disposition");
		return forwarded({ type: "input_disposition", inputId, disposition });
	},
	before_agent_start: (payload, { cwd }) => {
		const { prompt, systemPrompt, trigger, preview, systemPromptOptions } = payload;
		const images = imagesOf(payload.images);
		if (
			!isString(prompt) ||
			!isString(systemPrompt) ||
			images === null ||
			!isOneOf(trigger, TRIGGERS) ||
			!isOptional(preview, isBoolean) ||
			!isRecord(systemPromptOptions)
		)
			throw malformed("before_agent_start");
		// The loop's options as the loop built them: only `cwd` is this machine's (its workspace); the rest (context files,
		// skills, tools) describes the loop's machine. They are data for handlers to read; nothing here acts on them.
		const options = { ...(systemPromptOptions as Partial<BuildSystemPromptOptions>), cwd };
		return {
			emit: ({ runner, only }) =>
				runner.emitBeforeAgentStart(prompt, images, systemPrompt, options, {
					only,
					trigger,
					...(preview === undefined ? {} : { preview }),
				}),
		};
	},
	turn_start: ({ turnIndex, timestamp }) => {
		if (!isNumber(turnIndex) || !isNumber(timestamp)) throw malformed("turn_start");
		return forwarded({ type: "turn_start", turnIndex, timestamp });
	},
	turn_end: (payload, context) => {
		const { turnIndex, message, toolResults, messageEntryId, toolResultEntryIds } = payload;
		if (
			!isNumber(turnIndex) ||
			!isAgentMessage(message) ||
			!isToolResults(toolResults) ||
			!isString(messageEntryId) ||
			!isStrings(toolResultEntryIds)
		)
			throw malformed("turn_end");
		const step = boundaryOf("turn_end", payload);
		const base = { type: "turn_end" as const, turnIndex, message, toolResults, messageEntryId, toolResultEntryIds };
		return { emit: steppedBoundary({ ...base, outcome: step.outcome }, step, context) };
	},
	agent_before_settle: (payload, context) => {
		const step = boundaryOf("agent_before_settle", payload);
		return { emit: steppedBoundary({ type: "agent_before_settle", outcome: step.outcome }, step, context) };
	},
});
