import { type Agent, buildProviderContext, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Context,
	getCurrentSystemPrompt,
	getCurrentTools,
	type ModelsSimpleStreamOptions,
	type ProviderHeaders,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../cli/args.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type {
	BuildSystemPromptOptions,
	PromptCachePrefixRequestOptions,
	PromptCachePrefixResult,
	ServiceTier,
} from "./extensions/types.ts";
import type { ModelRuntime } from "./model-runtime.ts";

export interface PromptCachePrefixSources {
	readonly agent: Agent;
	readonly runner: ExtensionRunner;
	readonly modelRuntime: ModelRuntime;
	/** Settles once the session start the prefix depends on (tools, discovered skills) has run. */
	readonly ready: Promise<void>;
	getServiceTier(): ServiceTier | undefined;
	getBaseSystemPrompt(): string;
	getBaseSystemPromptOptions(): BuildSystemPromptOptions;
}

export const PROMPT_STARTED_REASON = "a prompt started composing its turn before the prefix was built";

// A handler may await work that rebuilds the base prompt (an MCP attach registering tools);
// one more pass composes from the rebuilt base, the one the first turn will start from.
const MAX_COMPOSITION_PASSES = 2;

const CANCELLED = Symbol("prompt-cache-prefix-cancelled");

/**
 * The session's in-flight prefix builds (senpi#2115). A real turn's `before_agent_start`
 * must never run beside a preview pass, so the host cancels every build before it emits one.
 */
export class PromptCachePrefixBuilds {
	readonly #inFlight = new Set<AbortController>();

	async build(
		sources: PromptCachePrefixSources,
		options: PromptCachePrefixRequestOptions = {},
	): Promise<PromptCachePrefixResult> {
		const controller = new AbortController();
		const signal =
			options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
		this.#inFlight.add(controller);
		try {
			return await buildPromptCachePrefixRequest(sources, signal);
		} finally {
			this.#inFlight.delete(controller);
		}
	}

	cancelAll(): void {
		for (const controller of this.#inFlight) controller.abort(PROMPT_STARTED_REASON);
		this.#inFlight.clear();
	}
}

/**
 * Build the provider request prefix of the next user turn (senpi#2096). Each input comes
 * from the source the turn itself reads, so the prewarmed prefix is the turn's prefix:
 * - system prompt: the base prompt through a `before_agent_start` preview pass, which is
 *   what `AgentSession.prompt()` installs as `agent.state.systemPrompt`;
 * - tools: `agent.state.tools` (and `declaredTools`) through the agent loop's own
 *   `buildProviderContext`, so an allowed-tools model gets the same declared list and
 *   callable subset;
 * - reasoning, thinking selection/budgets, session id, and `onPayload`: the fields
 *   `Agent.createLoopConfig()` passes to the stream function;
 * - service tier: the session's effective tier, which the SDK stream function applies to
 *   the active model;
 * - auth, headers, `extraBody`, env, and the upstream model id: `ModelRuntime` resolves
 *   them exactly as it does before `streamSimple`.
 *
 * The preview pass runs only handlers registered `previewSafe` (senpi#2115): a handler that
 * never declared itself safe could consume one-shot state for a turn that does not exist,
 * so while one is registered the build is skipped before any handler runs.
 */
export async function buildPromptCachePrefixRequest(
	sources: PromptCachePrefixSources,
	signal: AbortSignal,
): Promise<PromptCachePrefixResult> {
	if ((await untilAborted(sources.ready, signal)) === CANCELLED) return cancelled(signal);
	const unsafe = sources.runner.getPreviewUnsafeBeforeAgentStartPaths();
	if (unsafe.length > 0) {
		return skipped(`before_agent_start handlers not registered previewSafe: ${unsafe.join(", ")}`);
	}
	const systemPrompt = await untilAborted(composeTurnSystemPrompt(sources, signal), signal);
	if (systemPrompt === CANCELLED) return cancelled(signal);
	const { agent, runner } = sources;
	const state = agent.state;
	const model = state.model;
	if (model === undefined) return skipped("no model selected");
	const options: ModelsSimpleStreamOptions = {};
	const reasoning = loopReasoning(state.reasoningBaseline, state.thinkingLevel);
	if (reasoning !== undefined) options.reasoning = reasoning;
	if (state.thinkingSelection !== undefined) options.thinkingSelection = state.thinkingSelection;
	if (agent.thinkingBudgets !== undefined) options.thinkingBudgets = agent.thinkingBudgets;
	if (agent.sessionId !== undefined) options.sessionId = agent.sessionId;
	const serviceTier = sources.getServiceTier();
	if (serviceTier !== undefined) options.serviceTier = serviceTier;
	if (agent.onPayload !== undefined) options.onPayload = agent.onPayload;
	if (runner.hasHandlers("before_provider_headers")) {
		options.transformHeaders = async (headers: ProviderHeaders) => await runner.emitBeforeProviderHeaders(headers);
	}
	const prepared = await untilAborted(sources.modelRuntime.prepareSimpleRequest(model, options), signal);
	if (prepared === CANCELLED) return cancelled(signal);
	const transcript = await buildProviderContext(
		{
			systemPrompt,
			messages: [],
			tools: state.tools.slice(),
			...(state.declaredTools !== undefined ? { declaredTools: state.declaredTools.slice() } : {}),
		},
		{ convertToLlm: () => [], model },
	);
	if (signal.aborted) return cancelled(signal);
	return {
		status: "ready",
		request: { model: prepared.model, context: toPrefixContext(transcript), options: prepared.options },
	};
}

/**
 * `PromptCachePrefixRequest.context` is the pre-transcript `Context` that `warmPromptCache` and
 * extensions read (`systemPrompt`, `tools`, `activeToolNames`). `buildProviderContext` returns the
 * loop's `TranscriptContext`, whose prompt and tools live in the leading system message, so the
 * declaration is replayed back out of it; the tools stay the loop's provider declarations.
 */
function toPrefixContext(transcript: TranscriptContext): Context {
	return {
		systemPrompt: getCurrentSystemPrompt(transcript.messages),
		messages: transcript.messages.filter((message) => message.role !== "system"),
		tools: getCurrentTools(transcript.messages),
		...(transcript.activeToolNames === undefined ? {} : { activeToolNames: transcript.activeToolNames }),
	};
}

async function composeTurnSystemPrompt(sources: PromptCachePrefixSources, signal: AbortSignal): Promise<string> {
	let systemPrompt = sources.getBaseSystemPrompt();
	for (let pass = 0; pass < MAX_COMPOSITION_PASSES && !signal.aborted; pass += 1) {
		const base = sources.getBaseSystemPrompt();
		const result = await sources.runner.emitBeforeAgentStart(
			"",
			undefined,
			base,
			sources.getBaseSystemPromptOptions(),
			{ preview: true, signal },
		);
		systemPrompt = result?.systemPrompt ?? base;
		if (sources.getBaseSystemPrompt() === base) break;
	}
	return systemPrompt;
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof CANCELLED> {
	if (signal.aborted) return CANCELLED;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<typeof CANCELLED>((resolve) => {
		onAbort = () => resolve(CANCELLED);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work, aborted]);
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

function skipped(reason: string): PromptCachePrefixResult {
	return { status: "skipped", reason };
}

function cancelled(signal: AbortSignal): PromptCachePrefixResult {
	return skipped(typeof signal.reason === "string" ? signal.reason : "prefix build cancelled");
}

// Mirrors Agent.createLoopConfig(): the configuration-update baseline wins over the level.
function loopReasoning(
	baseline: string | undefined,
	thinkingLevel: ThinkingLevel,
): Exclude<ThinkingLevel, "off"> | undefined {
	const level = baseline !== undefined && isValidThinkingLevel(baseline) ? baseline : thinkingLevel;
	return level === "off" ? undefined : level;
}
