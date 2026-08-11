import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Context,
	isAnthropicApiBaseUrl,
	type Model,
	resolvePromptCacheTtlSeconds,
	type Tool,
	type WarmPromptCacheOptions,
	type WarmPromptCacheResult,
	warmPromptCache,
} from "@earendil-works/pi-ai";
import { convertToLlm, filterContextExcludedMessages } from "../../../messages.ts";
import { noticeEntryRenderer } from "../../notice/index.ts";
import type { EntryRenderer, ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../types.ts";
import { formatWarmTokenCount } from "../goal/cache-warm.ts";
import { GOAL_CONTINUATION_TIMER_STATE_EVENT } from "../goal/monitor-continuation.ts";

export const CACHE_KEEPALIVE_ENTRY_TYPE = "cache-keepalive";
export const CACHE_WARM_PING_EVENT = "cache_warm_ping";

interface StartedEntry {
	readonly phase: "started";
}

interface PingEntry {
	readonly phase: "ping";
	readonly iteration: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly estimatedCostUsd: number;
	readonly cumulativeEstimatedUsd: number;
}

interface StoppedEntry {
	readonly phase: "stopped";
	readonly iterations: number;
	readonly stopReason: string;
	readonly cumulativeEstimatedUsd: number;
}

export type CacheKeepAliveEntryData = StartedEntry | PingEntry | StoppedEntry;

type WarmPromptCacheFn = (
	model: Model<any>,
	context: Context,
	options?: WarmPromptCacheOptions,
) => Promise<WarmPromptCacheResult>;

export const renderCacheKeepAliveEntry: EntryRenderer<CacheKeepAliveEntryData> = noticeEntryRenderer((entry) => {
	const data = entry.data;
	if (data?.phase !== "ping") return undefined;
	const refreshed = data.cacheRead + data.cacheWrite;
	return {
		title: `⚡ Warm ping #${data.iteration} · ~${formatWarmTokenCount(refreshed)} tokens refreshed · ${formatUsd(data.estimatedCostUsd)}`,
		why: "Refreshed the active Anthropic prompt cache while the session was idle.",
		expandedLine: `cache read ${data.cacheRead} · cache write ${data.cacheWrite} · session total ${formatUsd(data.cumulativeEstimatedUsd)}`,
	};
});

export function createCacheKeepAliveExtension(
	dependencies: { readonly warmPromptCache?: WarmPromptCacheFn } = {},
): ExtensionFactory {
	const warm = dependencies.warmPromptCache ?? warmPromptCache;
	return (pi: ExtensionAPI) => {
		let ctx: ExtensionContext | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let inFlight = false;
		let generation = 0;
		let active = false;
		let goalTimerArmed = false;
		let attempts = 0;
		let cumulativeEstimatedUsd = 0;
		let lastCompletedAtMs: number | undefined;
		let lastMessages: AgentMessage[] = [];
		let lastUsage: { input: number; cacheRead: number; cacheWrite: number } | undefined;

		pi.registerEntryRenderer(CACHE_KEEPALIVE_ENTRY_TYPE, renderCacheKeepAliveEntry);

		const unsubscribeGoalTimer = pi.events?.on(GOAL_CONTINUATION_TIMER_STATE_EVENT, (data) => {
			if (!isGoalTimerState(data)) return;
			goalTimerArmed = data.armed;
			if (data.armed) stop("goal-timer-armed");
		});

		function append(data: CacheKeepAliveEntryData): void {
			pi.appendEntry(CACHE_KEEPALIVE_ENTRY_TYPE, data);
		}

		function stop(reason: string, forceEntry = false): void {
			const shouldAppend = active || inFlight || timer !== undefined || forceEntry;
			generation += 1;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			active = false;
			if (shouldAppend) {
				append({
					phase: "stopped",
					iterations: attempts,
					stopReason: reason,
					cumulativeEstimatedUsd,
				});
			}
		}

		function arm(): void {
			if (timer !== undefined || inFlight) return;
			const current = ctx;
			const settings = current?.getPromptCacheKeepAliveSettings?.();
			if (!settings?.enabled || current?.model === undefined || lastCompletedAtMs === undefined) return;
			if (!isWarmSupportedModel(current.model)) return;
			if (!current.isIdle()) {
				stop("agent-busy");
				return;
			}
			if (current.hasPendingMessages()) {
				stop("pending-messages");
				return;
			}
			if (goalTimerArmed) {
				stop("goal-timer-armed");
				return;
			}
			const safeWaitSeconds = current.getPromptCacheSafeWaitSeconds?.();
			if (safeWaitSeconds === undefined || !Number.isFinite(safeWaitSeconds)) return;
			if (attempts >= Math.max(0, settings.maxRequestsPerSession)) {
				stop("max-requests", true);
				return;
			}
			const projectedUsd = projectedPingCost(current.model, lastUsage);
			if (cumulativeEstimatedUsd + projectedUsd > Math.max(0, settings.maxCostUsdPerSession)) {
				stop("cost-cap", true);
				return;
			}
			if (!active) {
				active = true;
				append({ phase: "started" });
			}
			const intervalMs = Math.max(0, safeWaitSeconds - Math.max(0, settings.marginSeconds)) * 1000;
			const delayMs = Math.max(0, lastCompletedAtMs + intervalMs - Date.now());
			const scheduledGeneration = generation;
			timer = setTimeout(() => {
				timer = undefined;
				void ping(scheduledGeneration);
			}, delayMs);
		}

		async function ping(scheduledGeneration: number): Promise<void> {
			if (scheduledGeneration !== generation) return;
			const current = ctx;
			const settings = current?.getPromptCacheKeepAliveSettings?.();
			if (
				current === undefined ||
				settings?.enabled !== true ||
				current.model === undefined ||
				!isWarmSupportedModel(current.model) ||
				!current.isIdle() ||
				current.hasPendingMessages() ||
				goalTimerArmed ||
				attempts >= Math.max(0, settings.maxRequestsPerSession) ||
				cumulativeEstimatedUsd + projectedPingCost(current.model, lastUsage) >
					Math.max(0, settings.maxCostUsdPerSession)
			) {
				arm();
				return;
			}
			inFlight = true;
			attempts += 1;
			const iteration = attempts;
			const pingGeneration = generation;
			try {
				const preparation = await current.prepareProviderRequest?.(lastMessages);
				if (pingGeneration !== generation) {
					inFlight = false;
					arm();
					return;
				}
				const preparedMessages = preparation?.messages ?? lastMessages;
				const activeToolNames = new Set(pi.getActiveTools());
				const tools: Tool[] = pi
					.getAllTools()
					.filter((tool) => activeToolNames.has(tool.name))
					.map(({ name, description, parameters }) => ({ name, description, parameters }));
				const auth = await current.modelRegistry.getApiKeyAndHeaders(current.model);
				if (pingGeneration !== generation) {
					inFlight = false;
					arm();
					return;
				}
				if (!auth.ok) throw new Error(auth.error);
				const authHeaders = auth.headers ?? {};
				const headers = preparation ? await preparation.transformHeaders(authHeaders) : authHeaders;
				const result = await warm(
					current.model,
					{
						systemPrompt: current.getSystemPrompt(),
						messages: convertToLlm(filterContextExcludedMessages(preparedMessages)),
						...(tools.length > 0 ? { tools } : {}),
					},
					{
						apiKey: auth.apiKey,
						headers,
						sessionId: current.sessionManager.getSessionId(),
						cacheRetention: current.model.cacheRetention,
						onPayload: preparation ? async (payload) => await preparation.transformPayload(payload) : undefined,
					},
				);
				if (pingGeneration !== generation) {
					inFlight = false;
					arm();
					return;
				}
				if (!result.supported) {
					inFlight = false;
					stop("unsupported-model");
					return;
				}
				const estimatedCostUsd = actualPingCost(current.model, result.usage);
				cumulativeEstimatedUsd += estimatedCostUsd;
				lastCompletedAtMs = Date.now();
				const cachedTokens = result.usage.cacheRead + result.usage.cacheWrite;
				const ttlSeconds = resolvePromptCacheTtlSeconds(current.model) ?? 0;
				pi.events?.emit(CACHE_WARM_PING_EVENT, { iteration, cachedTokens, ttlSeconds, estimatedCostUsd });
				append({
					phase: "ping",
					iteration,
					cacheRead: result.usage.cacheRead,
					cacheWrite: result.usage.cacheWrite,
					estimatedCostUsd,
					cumulativeEstimatedUsd,
				});
				inFlight = false;
				arm();
			} catch {
				inFlight = false;
				if (pingGeneration === generation) stop("provider-error");
				else arm();
			}
		}

		pi.on("session_start", (_event, nextCtx) => {
			stop("session-restart");
			ctx = nextCtx;
			attempts = 0;
			cumulativeEstimatedUsd = 0;
			lastMessages = nextCtx.sessionManager.buildSessionContext().messages;
			const usage = lastAssistantUsage(lastMessages);
			lastUsage = usage;
			lastCompletedAtMs = lastAssistantTimestamp(lastMessages);
			arm();
		});

		pi.on("agent_end", (event, nextCtx) => {
			ctx = nextCtx;
			const usage = lastAssistantUsage(event.messages);
			if (usage?.stopReason === "error") {
				stop("provider-error");
				return;
			}
			lastMessages = [...event.messages];
			lastUsage = usage;
			lastCompletedAtMs = Date.now();
			arm();
		});

		pi.on("model_select", (_event, nextCtx) => {
			ctx = nextCtx;
			stop("model-changed");
			arm();
		});
		pi.on("agent_start", () => stop("agent-busy"));
		pi.on("input", () => stop("user-input"));
		pi.on("session_shutdown", () => {
			stop("session-dispose");
			unsubscribeGoalTimer?.();
			ctx = undefined;
		});
	};
}

function isWarmSupportedModel(model: Model<any>): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages" && isAnthropicApiBaseUrl(model.baseUrl);
}

function lastAssistantUsage(
	messages: readonly AgentMessage[],
): { input: number; cacheRead: number; cacheWrite: number; stopReason?: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return {
			input: finiteTokens(message.usage.input),
			cacheRead: finiteTokens(message.usage.cacheRead),
			cacheWrite: finiteTokens(message.usage.cacheWrite),
			stopReason: message.stopReason,
		};
	}
	return undefined;
}

function lastAssistantTimestamp(messages: readonly AgentMessage[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant" && Number.isFinite(message.timestamp)) return message.timestamp;
	}
	return undefined;
}

function projectedPingCost(
	model: Model<any>,
	usage: { input: number; cacheRead: number; cacheWrite: number } | undefined,
): number {
	const promptTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
	return (promptTokens * Math.max(model.cost.cacheRead, model.cost.cacheWrite)) / 1_000_000;
}

function actualPingCost(model: Model<any>, usage: { input: number; cacheRead: number; cacheWrite: number }): number {
	return (
		(usage.cacheRead * model.cost.cacheRead +
			usage.cacheWrite * model.cost.cacheWrite +
			usage.input * model.cost.input) /
		1_000_000
	);
}

function finiteTokens(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatUsd(value: number): string {
	return `$${value.toFixed(3)}`;
}

function isGoalTimerState(value: unknown): value is { armed: boolean; kind: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { armed?: unknown }).armed === "boolean" &&
		typeof (value as { kind?: unknown }).kind === "string"
	);
}

export default createCacheKeepAliveExtension();
