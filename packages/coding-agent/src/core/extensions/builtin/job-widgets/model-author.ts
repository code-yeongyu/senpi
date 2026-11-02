/**
 * A {@link JobWidgetAuthor} backed by one model: a single one-shot request with the respond tool
 * forced where the wire allows it, reasoning off and output capped. The model and the completion
 * function are injected, so nothing here reaches a network on its own and tests use fixed outputs.
 * Ported from oh-my-pi 9df0457b31 `job-widgets/author.ts` (MIT, Copyright Can Boluk et al.).
 */
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
} from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { parseJsonWithRepair } from "@earendil-works/pi-ai/utils/json-parse";
import { Type } from "typebox";
import { namedToolChoicePayload, supportsNamedToolChoice } from "../todotools/first-turn.ts";
import { JOB_WIDGET_RESPOND_TOOL, JOB_WIDGET_SYSTEM_PROMPT } from "./author-system-prompt.ts";
import type { JobWidgetAuthor } from "./author-types.ts";
import { renderJobWidgetUserPrompt } from "./author-user-prompt.ts";
import { JOB_WIDGET_SPEC_SCHEMA } from "./spec-schema.ts";

/** Output cap of a spec request: the largest valid spec stays well under it, a runaway answer does not. */
export const MAX_SPEC_TOKENS = 3000;

export type JobWidgetComplete = (
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type JobWidgetModelResolver = () => Model<Api> | undefined;

export interface JobWidgetModelSources {
	/** The explicit `jobWidgets.model` setting. */
	readonly setting?: JobWidgetModelResolver;
	/** A host-injected route to a cheap model (omo: its `quick` category). */
	readonly host?: JobWidgetModelResolver;
	readonly session?: JobWidgetModelResolver;
}

/**
 * Model resolution order: the explicit setting, then the host-injected resolver, then the
 * session's current model. The first that yields a model wins; none means no request is made.
 */
export function jobWidgetModelResolver(sources: JobWidgetModelSources): JobWidgetModelResolver {
	return () => sources.setting?.() ?? sources.host?.() ?? sources.session?.();
}

export interface ModelJobWidgetAuthorOptions {
	readonly resolveModel: JobWidgetModelResolver;
	/** Defaults to `completeSimple`; a host wraps it to add the session's credentials. */
	readonly complete?: JobWidgetComplete;
}

export class JobWidgetAuthorError extends Error {
	readonly stopReason: AssistantMessage["stopReason"];

	constructor(message: string, stopReason: AssistantMessage["stopReason"]) {
		super(message);
		this.name = "JobWidgetAuthorError";
		this.stopReason = stopReason;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The payload with `tool_choice` naming `respond`, or `undefined` to leave it as is: the model must
 * accept a named choice, the payload must carry none of its own, and Anthropic extended thinking
 * (which rejects forced tool use) must be off. Elsewhere the prompt asks for the call and a JSON
 * text answer is parsed instead.
 */
export function forceRespondChoice(payload: unknown, model: Model<Api>): unknown {
	if (!supportsNamedToolChoice(model) || !isRecord(payload) || payload.tool_choice !== undefined) return undefined;
	const thinking = isRecord(payload.thinking) ? payload.thinking.type : undefined;
	if (model.api === "anthropic-messages" && (thinking === "enabled" || thinking === "adaptive")) return undefined;
	const choice = namedToolChoicePayload(model.api, JOB_WIDGET_RESPOND_TOOL);
	return choice ? { ...payload, tool_choice: choice } : undefined;
}

/** The answer a response carries: the respond call's arguments, or a JSON object in its text. */
function jobWidgetAnswer(message: AssistantMessage): unknown {
	const call = message.content.find(
		(part): part is ToolCall => part.type === "toolCall" && part.name === JOB_WIDGET_RESPOND_TOOL,
	);
	if (call) return call.arguments;
	const text = message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) {
		throw new JobWidgetAuthorError("widget spec request returned no spec", message.stopReason);
	}
	return parseJsonWithRepair<unknown>(text.slice(start, end + 1));
}

export function createModelJobWidgetAuthor(options: ModelJobWidgetAuthorOptions): JobWidgetAuthor {
	const complete = options.complete ?? completeSimple;
	return async (request, signal) => {
		const model = options.resolveModel();
		if (!model) return undefined;
		const context: Context = {
			systemPrompt: JOB_WIDGET_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: renderJobWidgetUserPrompt(request) }],
					timestamp: Date.now(),
				},
			],
			tools: [
				{
					name: JOB_WIDGET_RESPOND_TOOL,
					description: "Install the widget spec for this job.",
					parameters: Type.Unsafe<unknown>({ ...JOB_WIDGET_SPEC_SCHEMA }),
				},
			],
		};
		// No `reasoning`: spec writing is formatting work, and a forced tool call rules out thinking on some providers.
		const response = await complete(model, context, {
			signal,
			maxTokens: MAX_SPEC_TOKENS,
			cacheRetention: model.cacheRetention === "none" ? "none" : "short",
			onPayload: (payload) => forceRespondChoice(payload, model),
		});
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new JobWidgetAuthorError(
				response.errorMessage ?? `widget spec request ${response.stopReason}`,
				response.stopReason,
			);
		}
		return jobWidgetAnswer(response);
	};
}
