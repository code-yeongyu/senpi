import {
	type Context,
	isOpenAIResponsesPromptCacheModel,
	type Model,
	type Usage,
	type WarmPromptCacheOptions,
	type WarmPromptCacheResult,
	type WarmPromptCacheUsage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { PROMPT_CACHE_PREWARM_ENTRY_TYPE, type PromptCachePrewarmEntryData } from "./prewarm-entry.ts";

export const PROMPT_CACHE_PREWARM_TIMEOUT_MS = 30_000;

export type WarmPromptCacheFn = (
	model: Model<any>,
	context: Context,
	options?: WarmPromptCacheOptions,
) => Promise<WarmPromptCacheResult>;

export interface SessionPrewarmDependencies {
	readonly warm: WarmPromptCacheFn;
	readonly isPrewarmModel?: ((model: Model<any>) => boolean) | undefined;
}

export interface SessionPrewarm {
	start(ctx: ExtensionContext): void;
	cancel(): void;
}

/**
 * One prompt-cache prewarm per session start for OpenAI GPT-5.6+ models (senpi#2096).
 * The request is the host's `getPromptCachePrefixRequest()` prefix, the first user turn's
 * request with an empty conversation, because the platform reuses a prefix only up to a
 * block boundary: a prewarmed system prompt that stops short of the turn's is never read.
 * When the host cannot build that prefix without side effects (an extension handler that is
 * not preview-safe, or a user prompt that already started its turn), a `skipped` entry
 * records why (senpi#2115).
 * The request runs detached from the turn pipeline, so it can never delay or fail the
 * first user turn; its billed usage is recorded as a custom entry that session stats count.
 */
export function createSessionPrewarm(pi: ExtensionAPI, dependencies: SessionPrewarmDependencies): SessionPrewarm {
	const isPrewarmModel = dependencies.isPrewarmModel ?? isOpenAIResponsesPromptCacheModel;
	let current: AbortController | undefined;

	function cancel(): void {
		current?.abort();
		current = undefined;
	}

	async function run(ctx: ExtensionContext, model: Model<any>, controller: AbortController): Promise<void> {
		const { signal } = controller;
		try {
			const prefix = await ctx.getPromptCachePrefixRequest?.({ signal });
			if (signal.aborted || prefix === undefined) return;
			if (prefix.status === "skipped") {
				append({ phase: "skipped", provider: model.provider, model: model.id, reason: prefix.reason });
				return;
			}
			const { request } = prefix;
			const result = await dependencies.warm(request.model, request.context, {
				...request.options,
				signal,
				timeoutMs: PROMPT_CACHE_PREWARM_TIMEOUT_MS,
			});
			if (signal.aborted || !result.supported) return;
			append({ phase: "warmed", provider: model.provider, model: model.id, usage: toUsage(model, result.usage) });
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			append({ phase: "failed", provider: model.provider, model: model.id, error: message });
		} finally {
			if (current === controller) current = undefined;
		}
	}

	function append(data: PromptCachePrewarmEntryData): void {
		pi.appendEntry(PROMPT_CACHE_PREWARM_ENTRY_TYPE, data);
	}

	return {
		start(ctx) {
			cancel();
			const model = ctx.model;
			if (model === undefined || model.cacheRetention === "none" || !isPrewarmModel(model)) return;
			const controller = new AbortController();
			current = controller;
			void run(ctx, model, controller);
		},
		cancel,
	};
}

function toUsage(model: Model<any>, usage: WarmPromptCacheUsage): Usage {
	const cost = usage.cost ?? {
		input: (usage.input * model.cost.input) / 1_000_000,
		output: (usage.output * model.cost.output) / 1_000_000,
		cacheRead: (usage.cacheRead * model.cost.cacheRead) / 1_000_000,
		cacheWrite: (usage.cacheWrite * model.cost.cacheWrite) / 1_000_000,
		total: 0,
	};
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
	};
}
