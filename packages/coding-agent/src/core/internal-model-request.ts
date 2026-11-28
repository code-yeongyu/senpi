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
	TURN_RETRY_SUPPRESSION_PREFIX,
} from "@earendil-works/pi-ai";
import { isCommittedRotationOutput } from "./credential-pool/rotation-events.ts";
import { RetryFallbackController } from "./retry-fallback/controller.ts";
import type { FallbackSettings } from "./retry-fallback/controller-types.ts";
import { SelectorCooldowns } from "./retry-fallback/cooldown.ts";
import { createFallbackLogger } from "./retry-fallback/log.ts";

/** The subset of `ModelRuntime` an auxiliary request needs. `ModelRuntime` satisfies this shape. */
export interface InternalStreamRuntime {
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	getModel(providerId: string, modelId: string): Model<Api> | undefined;
	getModels(): readonly Model<Api>[];
	isUsingOAuth(providerId: string): boolean;
	isFallbackEligible(providerId: string): boolean;
	hasConfiguredAuth(providerId: string): boolean;
}

/** Simple-stream options plus the effort field a typed (`runtime.stream`) caller sets instead of `reasoning`. */
export type InternalStreamOptions = ModelsSimpleStreamOptions & { reasoningEffort?: ThinkingLevel };

/** An auxiliary request moved to the next rung of its model's fallback chain; the session model is unchanged. */
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

export interface StreamInternalModelConfig {
	/** What the request is for ("compaction", "side query", ...), carried on the fallback event. */
	source: string;
	/** The session's fallback policy. Absent: the request runs on its model with no fallback. */
	settings?: { getRetryFallbackSettings(): FallbackSettings };
	agentDir: string;
	/** Runs the request on the caller's own model; a fallback rung always runs through `runtime.streamSimple`. */
	streamFn?: InternalStreamFunction;
	notify?: (event: InternalModelFallbackEvent) => void;
}

/**
 * Cooldowns an auxiliary walk records, per runtime. They are separate from the session's own
 * controller, so a failed summary request never moves the session's chat model.
 */
const cooldownsByRuntime = new WeakMap<object, SelectorCooldowns>();

/**
 * Streams an auxiliary request (compaction, title, branch summary, side query, vision) on `model`
 * and, when the session's fallback policy has a chain for that model, moves the request to the
 * chain's next rung on a failure that arrives before any output. The caller's chat model is not
 * changed. A rung on another model gets none of the caller's resolved request material (key,
 * headers, extra body, env, effort): the runtime resolves that model's own auth for the session.
 */
export function streamInternalModel(
	runtime: InternalStreamRuntime,
	model: Model<Api>,
	context: Context,
	options: InternalStreamOptions,
	config: StreamInternalModelConfig & {
		streamFn?: (...args: Parameters<InternalStreamFunction>) => AssistantMessageEventStream;
	},
): AssistantMessageEventStream;
export function streamInternalModel(
	runtime: InternalStreamRuntime,
	model: Model<Api>,
	context: Context,
	options: InternalStreamOptions,
	config: StreamInternalModelConfig,
): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
export function streamInternalModel(
	runtime: InternalStreamRuntime,
	model: Model<Api>,
	context: Context,
	options: InternalStreamOptions,
	config: StreamInternalModelConfig,
): AssistantMessageEventStream | Promise<AssistantMessageEventStream> {
	const settings = config.settings;
	const runOriginal = (): AssistantMessageEventStream | Promise<AssistantMessageEventStream> =>
		config.streamFn ? config.streamFn(model, context, options) : runtime.streamSimple(model, context, options);
	if (!settings?.getRetryFallbackSettings().modelFallback) return runOriginal();

	let cooldowns = cooldownsByRuntime.get(runtime);
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
		logger: createFallbackLogger(config.agentDir),
		getCurrentSelector: () => current,
		isAuthAvailable: (provider) => runtime.hasConfiguredAuth(provider),
		switchModel: async (next, thinkingLevel) => {
			current = { model: next, thinkingLevel };
		},
		emit: (event) => {
			if (event.type !== "retry_fallback_applied") return;
			config.notify?.({
				type: "internal_model_fallback",
				source: config.source,
				from: event.from,
				to: event.to,
				reason: event.reason,
				chainKey: event.chainKey,
			});
		},
	});
	// No chain for this model: the native stream runs exactly as the caller supplied it, so its
	// rejection identity and synchronous throws reach the caller unchanged.
	if (!controller.hasConfiguredChain()) return runOriginal();

	return lazyStream(model, async () =>
		(async function* () {
			if (cooldowns.isSuppressed(`${model.provider}/${model.id}`)) {
				if (!(await controller.tryFallback("hard-error", { errorMessage: "Model is in cooldown" }))) {
					throw new Error("Internal model and its fallback chain are unavailable");
				}
			}
			while (true) {
				options.signal?.throwIfAborted();
				const changed = current.model.provider !== model.provider || current.model.id !== model.id;
				const { apiKey, headers, extraBody, env, reasoningEffort, reasoning, ...neutral } = options;
				let stream: AssistantMessageEventStream;
				try {
					stream = changed
						? runtime.streamSimple(current.model, context, {
								...neutral,
								...(current.thinkingLevel === "off" ? {} : { reasoning: current.thinkingLevel }),
								maxRetries: 0,
							})
						: await runOriginal();
				} catch (streamError) {
					// A synchronous throw reaches the caller as the original error, not as a wrapped error event.
					if (
						options.signal?.aborted ||
						!(await controller.tryFallback("hard-error", {
							errorMessage: streamError instanceof Error ? streamError.message : String(streamError),
						}))
					) {
						throw streamError;
					}
					continue;
				}
				let committed = false;
				let failure: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
				for await (const event of stream) {
					if (event.type === "error") {
						failure = event;
						break;
					}
					committed ||= isCommittedRotationOutput(event);
					yield event;
				}
				if (!failure) return;
				const error = failure.error;
				if (
					committed ||
					options.signal?.aborted ||
					error.errorMessage?.startsWith(TURN_RETRY_SUPPRESSION_PREFIX) ||
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
