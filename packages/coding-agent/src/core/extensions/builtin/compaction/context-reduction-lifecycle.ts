import type { Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { buildCompactionContext } from "./context-pipeline.ts";
import { createReductionHandoff } from "./context-reduction-handoff.ts";
import {
	CONTEXT_REDUCTION_ENTRY_TYPE,
	type ContextReductionRequest,
	clearReductionAnchor,
	createContextReductionState,
	readContextReductionState,
	recordReductionUsage,
	snapshotReductionState,
} from "./context-reduction-state.ts";
import type { EmergencyPruneLatch } from "./emergency-prune.ts";
import { getPromptContextWindow } from "./extension-wiring.ts";
import { isOpenAiRemoteCompactionModel } from "./openai-remote-model.ts";
import { resolveCompactionGeometry } from "./orchestration.ts";
import { estimateTotalTokens } from "./overflow-retry.ts";
import { computeEffectiveThreshold } from "./policy.ts";
import type { CompactionYieldSnapshot } from "./state.ts";

export function registerContextReductionLifecycle(
	pi: ExtensionAPI,
	options: {
		emergencyPruneLatch: EmergencyPruneLatch;
		emergencyInstructions: string;
		getTools: () => Tool[];
		getPolicy: (ctx: ExtensionContext) => {
			lastYield?: CompactionYieldSnapshot;
			breakerTripped: boolean;
			laneOwnsCompaction: boolean;
			appendOnlyTranscript: boolean;
		};
		logEmergencyPrune: (ctx: ExtensionContext, fields: { tokensBefore: number; tokens: number }) => void;
		logBreakerFallback: (ctx: ExtensionContext, tokens: number) => void;
	},
) {
	let state = createContextReductionState();
	let sessionId: string | undefined;
	let pending: (ContextReductionRequest & { leaf: string | null }) | undefined;
	const handoff = createReductionHandoff(pi, options.emergencyInstructions);
	const reset = () => {
		state = createContextReductionState();
		sessionId = undefined;
		pending = undefined;
	};
	const persist = (before: string) => {
		const saved = snapshotReductionState(state);
		if (JSON.stringify(saved) !== before) pi.appendEntry(CONTEXT_REDUCTION_ENTRY_TYPE, saved);
	};
	const restore = (ctx: ExtensionContext) => {
		if (sessionId === ctx.sessionManager.getSessionId()) return;
		state = createContextReductionState();
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "compaction") break;
			if (entry.type === "custom" && entry.customType === CONTEXT_REDUCTION_ENTRY_TYPE) {
				state = readContextReductionState(entry.data) ?? createContextReductionState();
				break;
			}
		}
		sessionId = ctx.sessionManager.getSessionId();
	};

	// Navigation reloads the destination branch's own record; the frontier
	// validates its fingerprint against the live projection before reusing it.
	const resetForNavigation = () => {
		handoff.reset();
		reset();
	};
	pi.on("session_start", resetForNavigation);
	pi.on("session_tree", resetForNavigation);
	pi.on("session_shutdown", resetForNavigation);
	pi.on("message_end", (event, ctx) => {
		const request = pending;
		if (!request || sessionId !== ctx.sessionManager.getSessionId() || event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted" || event.message.stopReason === "error") return;
		if (request.leaf && !ctx.sessionManager.getBranch().some((entry) => entry.id === request.leaf)) return;
		const before = JSON.stringify(snapshotReductionState(state));
		const usage = event.message.usage;
		recordReductionUsage(state, request, usage.input + usage.cacheRead + usage.cacheWrite);
		pending = undefined;
		persist(before);
	});
	pi.on(
		"context",
		(event, ctx) => {
			restore(ctx);
			// The journal may not yet contain the current user/tool message.
			// The dispatcher, not transcript equality, owns request provenance.
			const live = event.source !== "projection";
			const working = live ? state : { ...state };
			if (!live) clearReductionAnchor(working);
			if (!live || !handoff.isPending()) delete working.compactionRequired;
			const before = JSON.stringify(snapshotReductionState(state));
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200_000;
			const settings = ctx.getCompactionSettings();
			const policy = options.getPolicy(ctx);
			const overheadTokens = estimateTotalTokens([
				{ role: "user", content: `${ctx.getSystemPrompt()}\n${JSON.stringify(options.getTools())}`, timestamp: 0 },
			]);
			const promptContextWindow = getPromptContextWindow(contextWindow, ctx.model?.maxTokens);
			const { thresholdTokens, reserveTokens } = resolveCompactionGeometry({
				contextWindow,
				settings,
				lastYield: policy.lastYield,
			});
			const breakerFallback =
				!policy.laneOwnsCompaction &&
				policy.breakerTripped &&
				usage?.tokens !== null &&
				usage !== undefined &&
				usage.tokens >= contextWindow * computeEffectiveThreshold(contextWindow, policy.lastYield);
			if (breakerFallback) options.logBreakerFallback(ctx, usage.tokens ?? 0);
			const messages = buildCompactionContext({
				event,
				ctx,
				contextWindow,
				promptContextWindow,
				contextReductionState: working,
				contextOverheadTokens: overheadTokens,
				reductionCeilingTokens: Math.min(promptContextWindow, contextWindow - reserveTokens, thresholdTokens),
				toolAdmissionEnabled: settings.toolAdmissionEnabled !== false,
				breakerFallback,
				laneOwnsCompaction: policy.laneOwnsCompaction,
				appendOnlyTranscript: policy.appendOnlyTranscript,
				emergencyPruneLatch: live ? options.emergencyPruneLatch : { ...options.emergencyPruneLatch },
				logEmergencyPrune: (fields) => options.logEmergencyPrune(ctx, fields),
			});
			const managed =
				!policy.laneOwnsCompaction && !policy.appendOnlyTranscript && !isOpenAiRemoteCompactionModel(ctx.model);
			if (!live) return { messages };
			if (!managed) {
				pending = undefined;
				return { messages };
			}
			if (state.compactionRequired) {
				pending = undefined;
				persist(before);
				// Never dispatch a prompt that is legal only because pruning changed
				// its lineage. Only an accepted, current handoff can resume work.
				handoff.request(ctx);
			} else {
				persist(before);
				pending = {
					count: event.messages.length,
					cut: state.cutIndex,
					hash: state.prefixHash,
					leaf: ctx.sessionManager.getLeafId(),
				};
			}
			return { messages };
		},
		{ mutatesMessages: false },
	);
	return { reset };
}
