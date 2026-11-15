import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { hookModelOf, hookRequestOutputOf, parseHookRequestInput } from "../../core/hand/hook-contract.ts";
import type { ModelSelectSource } from "../../core/extensions/types.ts";
import type { BuildSystemPromptOptions } from "../../core/system-prompt.ts";
import {
	isNumber,
	isOneOf,
	isOptional,
	isRecord,
	isString,
	loopHookFamily,
	malformed,
	forwarded,
} from "./loop-hook-payloads.ts";
import { isModel } from "./loop-hook-message-shapes.ts";

// A hosted loop's provider and model events (senpi#5898). The request hooks get the projected request (CK21); the
// request headers never leave the loop (`before_provider_headers` is loop-only, see `LOOP_HOOK_FORWARDING`).
// `provider_login_start` reports its handlers' progress lines in the reply (`progress`), for the loop's login to show.

const MODEL_SELECT_SOURCES = [
	"set",
	"cycle",
	"restore",
	"fallback",
	"fallback-revert",
] as const satisfies readonly ModelSelectSource[];
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

const isHeaderValues = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every(isString);

export const PROVIDER_LOOP_HOOKS = loopHookFamily({
	before_provider_request: (payload) => {
		// The user's hooks get the projected input (payload and effective model, no headers); the reply's `output`
		// carries the payload they produced.
		const input = parseHookRequestInput(payload.input);
		const model = hookModelOf(input);
		return {
			emit: async ({ runner, only }) => ({
				output: hookRequestOutputOf(
					input,
					await runner.emitBeforeProviderRequest(structuredClone(input.payload), undefined, undefined, {
						only,
						...(model === undefined ? {} : { model }),
					}),
				),
			}),
		};
	},
	after_provider_response: ({ status, headers }) => {
		if (!isNumber(status) || !isHeaderValues(headers)) throw malformed("after_provider_response");
		return forwarded({ type: "after_provider_response", status, headers });
	},
	provider_stream_event: ({ provider, api, model, data }) => {
		if (!isString(provider) || !isString(api) || !isString(model) || data === undefined)
			throw malformed("provider_stream_event");
		return forwarded({ type: "provider_stream_event", provider, api, model, data });
	},
	provider_login_start: ({ provider }) => {
		if (!isString(provider)) throw malformed("provider_login_start");
		return {
			emit: async ({ runner, only, signal }) => {
				const progress: string[] = [];
				const event = { type: "provider_login_start" as const, provider, signal };
				await runner.emitProviderLoginStart({ ...event, progress: (line) => progress.push(line) }, only);
				return progress.length === 0 ? undefined : { progress };
			},
		};
	},
	model_select: ({ model, previousModel, source, systemPrompt, systemPromptOptions }, cwd) => {
		if (
			!isModel(model) ||
			!isOptional(previousModel, isModel) ||
			!isOneOf(source, MODEL_SELECT_SOURCES) ||
			!isString(systemPrompt) ||
			!isRecord(systemPromptOptions)
		)
			throw malformed("model_select");
		// As for `before_agent_start`: the loop's options, except `cwd`, which is this machine's workspace.
		const options = { ...(systemPromptOptions as Partial<BuildSystemPromptOptions>), cwd };
		const event = {
			type: "model_select" as const,
			model,
			previousModel,
			source,
			systemPrompt,
			systemPromptOptions: options,
		};
		return { emit: ({ runner, only }) => runner.emitModelSelect(event, only) };
	},
	system_prompt_change: (payload) => {
		const { systemPrompt, previousSystemPrompt, systemPromptName, model, previousModel, source } = payload;
		if (
			!isString(systemPrompt) ||
			!isString(previousSystemPrompt) ||
			!isOptional(systemPromptName, isString) ||
			!isModel(model) ||
			!isOptional(previousModel, isModel) ||
			source !== "model_select"
		)
			throw malformed("system_prompt_change");
		return forwarded({
			type: "system_prompt_change",
			systemPrompt,
			previousSystemPrompt,
			model,
			previousModel,
			source,
			...(systemPromptName === undefined ? {} : { systemPromptName }),
		});
	},
	thinking_level_select: ({ level, previousLevel }) => {
		if (!isOneOf(level, THINKING_LEVELS) || !isOneOf(previousLevel, THINKING_LEVELS))
			throw malformed("thinking_level_select");
		return forwarded({ type: "thinking_level_select", level, previousLevel });
	},
});
