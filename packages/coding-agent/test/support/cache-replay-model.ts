/** Offline context projections only: excludes cache reads and generated compaction summaries. */
import * as contextPipeline from "../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import * as contextReduction from "../../src/core/extensions/builtin/compaction/context-reduction.ts";
import type { ContextReductionState } from "../../src/core/extensions/builtin/compaction/context-reduction-state.ts";
import { createEmergencyPruneLatch } from "../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { computeEffectiveThreshold } from "../../src/core/extensions/builtin/compaction/policy.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { buildSessionContext, type FileEntry, type SessionEntry } from "../../src/core/session-manager.ts";

export function cacheWriteTokens(previous: Buffer | undefined, current: Buffer): number {
	let common = 0;
	if (previous) {
		const limit = Math.min(previous.length, current.length);
		while (common < limit && previous[common] === current[common]) common++;
	}
	return Math.ceil((current.length - common) / 4);
}

export function replayContextCache(
	fileEntries: FileEntry[],
	options: { contextWindow: number; fixedPrefixTokens: number; feedback: boolean; blockBudgetRatio?: number },
) {
	const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const caches = new Map<string, Buffer>();
	const requests = new Map<
		string,
		{
			lineage: string;
			compaction: string;
			state: ContextReductionState;
			count: number;
			usage: number;
			children: number;
		}
	>();
	let cacheWrites = 0;
	let peakContext = 0;
	let peakRecordedContext = 0;
	let frontierSteps = 0;
	let shapeChanges = 0;
	let lastShape: string | undefined;
	let count = 0;
	let compactionRequiredRequests = 0;
	let recordedUsageAnchors = 0;
	let totalOutgoingRequestTokens = 0;
	const prefix = "s".repeat(options.fixedPrefixTokens * 4);
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const observedUsage = entry.message.usage;
		const recordedContext = observedUsage.input + observedUsage.cacheRead + observedUsage.cacheWrite;
		if (!options.feedback && recordedContext === 0) continue;
		peakRecordedContext = Math.max(peakRecordedContext, recordedContext);
		const branch: SessionEntry[] = [];
		let cursor = entry.parentId ? byId.get(entry.parentId) : undefined;
		let ancestor: ReturnType<typeof requests.get>;
		while (cursor) {
			branch.push(cursor);
			ancestor ??= requests.get(cursor.id);
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
		}
		branch.reverse();
		const compaction = branch.findLast((candidate) => candidate.type === "compaction")?.id ?? "root";
		const reset = !ancestor || ancestor.compaction !== compaction || ancestor.children > 0;
		const lineage = ancestor && !reset ? ancestor.lineage : entry.id;
		if (ancestor) ancestor.children++;
		const state: ContextReductionState =
			ancestor && !reset ? { ...ancestor.state } : { engaged: false, cutIndex: 0, prefixHash: "" };
		const beforeCut = state.cutIndex;
		const messages = buildSessionContext(entries, entry.parentId, byId).messages;
		if (options.feedback && ancestor && !reset && !ancestor.state.compactionRequired) {
			state.anchorCount = ancestor.count;
			state.anchorCut = ancestor.state.cutIndex;
			state.anchorHash = ancestor.state.prefixHash;
			state.anchorTokens = ancestor.usage;
		} else if (!options.feedback && Reflect.has(contextPipeline, "readContextReductionState")) {
			const entry = branch.findLast(
				(item) => item.type === "custom" && item.customType === "senpi.context-reduction.v1",
			);
			const saved = entry?.type === "custom" ? contextPipeline.readContextReductionState(entry.data) : undefined;
			if (
				saved?.anchorCount !== undefined &&
				saved.anchorCount <= messages.length &&
				saved.anchorCut === state.cutIndex &&
				saved.anchorHash === state.prefixHash
			) {
				state.anchorCount = saved.anchorCount;
				state.anchorCut = saved.anchorCut;
				state.anchorHash = saved.anchorHash;
				state.anchorTokens = saved.anchorTokens;
				recordedUsageAnchors++;
			}
		}
		const unreduced = estimateTotalTokens(messages) + options.fixedPrefixTokens;
		peakContext = Math.max(peakContext, unreduced);
		const previousUsage = ancestor?.usage ?? 0;
		const ctx = {
			model: undefined,
			sessionManager: { getBranch: () => branch },
			getContextUsage: () => ({ tokens: previousUsage, contextWindow: options.contextWindow }),
		} as ExtensionContext;
		const outgoing = contextPipeline.buildCompactionContext({
			event: { type: "context", messages },
			ctx,
			contextWindow: options.contextWindow,
			promptContextWindow: options.contextWindow - 16_384,
			reductionCeilingTokens: Math.min(
				options.contextWindow - 40_000,
				options.contextWindow * computeEffectiveThreshold(options.contextWindow),
			),
			contextReductionState: state,
			contextOverheadTokens: options.fixedPrefixTokens,
			contextReductionBlockBudgetRatio: options.blockBudgetRatio,
			toolAdmissionEnabled: true,
			breakerFallback: false,
			laneOwnsCompaction: false,
			emergencyPruneLatch: createEmergencyPruneLatch(),
		});
		if (state.cutIndex !== beforeCut) frontierSteps++;
		if (state.compactionRequired) compactionRequiredRequests++;
		const reduced = Reflect.has(contextPipeline, "createContextReductionState")
			? state.engaged
			: contextReduction.shouldApplyContextReduction({
					usageTokens: previousUsage,
					contextWindow: options.contextWindow,
				});
		const shape = reduced ? "reduced" : "full";
		if (lastShape !== undefined && shape !== lastShape) shapeChanges++;
		lastShape = shape;
		const key = `${lineage}/${compaction}/${shape}`;
		// Provider payloads do not include assistant billing metadata.
		const payload = outgoing.map((message) => {
			const { role, content } = message;
			return role === "toolResult"
				? { role, toolCallId: message.toolCallId, toolName: message.toolName, content }
				: { role, content };
		});
		const wire = Buffer.from(JSON.stringify({ system: prefix, messages: payload }));
		cacheWrites += cacheWriteTokens(caches.get(key), wire);
		caches.set(key, wire);
		const outgoingRequestTokens = estimateTotalTokens(outgoing) + options.fixedPrefixTokens;
		totalOutgoingRequestTokens += outgoingRequestTokens;
		requests.set(entry.id, {
			lineage,
			compaction,
			state,
			count: messages.length,
			children: 0,
			usage: options.feedback ? outgoingRequestTokens : recordedContext,
		});
		count++;
	}
	return {
		blockBudgetPercent: (options.blockBudgetRatio ?? 0.1) * 100,
		averageOutgoingRequestTokens: count === 0 ? 0 : Math.round((totalOutgoingRequestTokens / count) * 100) / 100,
		requests: count,
		compactionRequiredRequests,
		recordedUsageAnchors,
		peakUnreducedContextTokens: peakContext,
		peakRecordedContextTokens: options.feedback ? null : peakRecordedContext,
		frontierSteps,
		shapeChanges,
		cacheWriteTokens: cacheWrites,
		cacheWriteUsd: Math.round((cacheWrites / 1_000_000) * 12.5 * 100) / 100,
		priceUsdPerMillion: 12.5,
		tokenModel: "ceil(UTF-8 serialized suffix bytes / 4)",
		usageModel: options.feedback
			? "estimated same-lineage feedback"
			: "recorded gate usage; only persisted matching frontier anchors",
	};
}
