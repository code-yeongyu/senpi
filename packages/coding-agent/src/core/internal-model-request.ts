import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	isContextOverflow,
	lazyStream,
	type Model,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { RetryFallbackController } from "./retry-fallback/controller.ts";
import { SelectorCooldowns } from "./retry-fallback/cooldown.ts";
import { createFallbackLogger } from "./retry-fallback/log.ts";
import type { ResolvedRetryFallbackSettings } from "./retry-fallback/settings.ts";

/** The subset of `ModelRuntime` an auxiliary request needs. `ModelRuntime` satisfies this shape. */
export interface InternalStreamRuntime {
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	getModel(providerId: string, modelId: string): Model<Api> | undefined;
	getModels(): readonly Model<Api>[];
	isUsingOAuth(providerId: string): boolean;
	isFallbackEligible(providerId: string): boolean;
	hasConfiguredAuth(providerId: string): boolean;
}

/** Simple-stream options plus the auxiliary fields and API-specific passthrough the request needs. */
export type InternalStreamOptions = ModelsSimpleStreamOptions & {
	reasoningEffort?: ThinkingLevel;
	purpose?: string;
	[key: string]: unknown;
};

export interface InternalModelFallbackEvent {
	type: "internal_model_fallback";
	source: string;
	from: string;
	to: string;
	reason: string;
	chainKey: string;
}

export type InternalStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: InternalStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface InternalModelSettings {
	getRetryFallbackSettings(): ResolvedRetryFallbackSettings;
}

export interface StreamInternalModelConfig {
	settings?: InternalModelSettings;
	cooldowns?: SelectorCooldowns;
	streamFn?: InternalStreamFunction;
	notify?: (event: InternalModelFallbackEvent) => void;
	/** Injected agent directory; replaces the private `ModelRuntime.poolStatePath` read the installed build used. */
	agentDir?: string;
}

const cooldownsByRuntime = new WeakMap<object, SelectorCooldowns>();

/**
 * Streams an auxiliary request through the account-fallback lane without changing the
 * caller's configured chat model. Credential material is stripped exactly at the
 * internal seams: pre-resolved Codex OAuth before dispatch, and all resolved
 * provider-specific material on a cross-provider fallback. Explicit external
 * `ModelRuntime` `apiKey` calls are unaffected.
 */
export function streamInternalModel(
	runtime: InternalStreamRuntime,
	model: Model<Api>,
	context: Context,
	options?: InternalStreamOptions,
	config?: Omit<StreamInternalModelConfig, "streamFn"> & {
		streamFn?: (...args: Parameters<InternalStreamFunction>) => AssistantMessageEventStream;
	},
): AssistantMessageEventStream;
export function streamInternalModel(
	runtime: InternalStreamRuntime,
	model: Model<Api>,
	context: Context,
	options: InternalStreamOptions | undefined,
	config: StreamInternalModelConfig,
): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
export function streamInternalModel(
	runtime: InternalStreamRuntime,
	model: Model<Api>,
	context: Context,
	options: InternalStreamOptions = {},
	config: StreamInternalModelConfig = {},
): AssistantMessageEventStream | Promise<AssistantMessageEventStream> {
	let effectiveOptions = options;
	if (model.provider === "openai-codex" && runtime.isUsingOAuth(model.provider)) {
		const { apiKey, ...neutral } = effectiveOptions;
		effectiveOptions = neutral;
	}
	const settings = config.settings;
	// Without a session fallback policy, preserve the native stream and its
	// original rejection/cancellation semantics after removing the OAuth snapshot.
	if (!settings?.getRetryFallbackSettings().modelFallback) {
		return config.streamFn
			? config.streamFn(model, context, effectiveOptions)
			: runtime.streamSimple(model, context, effectiveOptions);
	}
	const agentDir = config.agentDir ?? getAgentDir();
	let cooldowns = config.cooldowns ?? cooldownsByRuntime.get(runtime);
	if (!cooldowns) {
		cooldowns = new SelectorCooldowns(Date.now);
		cooldownsByRuntime.set(runtime, cooldowns);
	}
	const initialThinking: ThinkingLevel = options.reasoning ?? options.reasoningEffort ?? "off";
	let current: { model: Model<Api>; thinkingLevel: ThinkingLevel } = { model, thinkingLevel: initialThinking };
	const needsImages = context.messages.some(
		(message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
	);
	const controller = new RetryFallbackController({
		getSettings: () => settings.getRetryFallbackSettings(),
		registry: {
			find: (provider, id) => {
				const candidate = runtime.getModel(provider, id);
				return needsImages && !candidate?.input.includes("image") ? undefined : candidate;
			},
			getAll: () => [...runtime.getModels()],
			isUsingOAuth: (candidate) => runtime.isUsingOAuth(candidate.provider),
			isFallbackEligible: (candidate) => runtime.isFallbackEligible(candidate.provider),
		},
		cooldowns,
		logger: createFallbackLogger(agentDir),
		getCurrentSelector: () => current,
		isAuthAvailable: (provider) => runtime.hasConfiguredAuth(provider),
		switchModel: async (next, thinkingLevel) => {
			current = { model: next, thinkingLevel };
		},
		emit: (event) => {
			if (event.type !== "retry_fallback_applied") return;
			config.notify?.({
				...event,
				type: "internal_model_fallback",
				source: effectiveOptions.purpose ?? "internal",
			});
		},
	});
	return lazyStream(model, async () =>
		(async function* () {
			if (cooldowns.isSuppressed(`${model.provider}/${model.id}`)) {
				if (!(await controller.tryFallback("hard-error", { errorMessage: "Model is in cooldown" }))) {
					throw new Error("Internal model and its fallback chain are unavailable");
				}
			}
			while (true) {
				effectiveOptions.signal?.throwIfAborted();
				const changed = current.model.provider !== model.provider || current.model.id !== model.id;
				const { apiKey, headers, extraBody, env, reasoningEffort, reasoning, ...neutral } = effectiveOptions;
				const requestOptions: InternalStreamOptions = changed
					? {
							...neutral,
							...(current.thinkingLevel === "off" ? {} : { reasoning: current.thinkingLevel }),
							maxRetries: 0,
						}
					: effectiveOptions;
				const stream =
					changed || !config.streamFn
						? runtime.streamSimple(current.model, context, requestOptions)
						: await config.streamFn(current.model, context, requestOptions);
				let committed = false;
				let failure: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
				for await (const event of stream) {
					if (event.type === "error") {
						failure = event;
						break;
					}
					committed ||= event.type !== "start";
					yield event;
				}
				if (!failure) return;
				const error = failure.error;
				if (
					committed ||
					effectiveOptions.signal?.aborted ||
					error.errorMessage?.startsWith("senpi:no-turn-retry:") ||
					isContextOverflow(error, current.model.contextWindow) ||
					!(await controller.tryFallback("hard-error", { errorMessage: error.errorMessage }))
				) {
					yield failure;
					return;
				}
			}
		})(),
	);
}
