/**
 * Offline #900 cost model. Run from the repository root with Bun:
 *   bun packages/coding-agent/test/support/replay-context-cache.ts --synthetic
 *   bun packages/coding-agent/test/support/replay-context-cache.ts --session /private/session.jsonl
 *
 * Copy this support file unchanged into a baseline checkout to compare its real
 * context pipeline. It intentionally imports no new frontier API. No provider
 * calls, session writes, or transcript output. JSON stdout contains aggregates.
 *
 * Cache = byte LCP with the previous request in the same branch/compaction and
 * full/reduced lineage. Tokens = ceil(UTF-8 bytes / 4), an explicit surrogate,
 * NOT Anthropic's tokenizer or a reconstruction of a provider's billing ledger.
 * No TTL expiry, cache-block lookback limit, or dynamic system/tools changes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildCompactionContext } from "../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import * as contextReduction from "../../src/core/extensions/builtin/compaction/context-reduction.ts";
import { createEmergencyPruneLatch } from "../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { computeEffectiveThreshold } from "../../src/core/extensions/builtin/compaction/policy.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	buildSessionContext,
	type FileEntry,
	parseSessionEntries,
	type SessionEntry,
} from "../../src/core/session-manager.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 375 requests, 288 tool results (180 eval), ~575k peak including a 52.6k prefix. */
export function syntheticCacheSession(): FileEntry[] {
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id: "cache-fixture", timestamp: new Date(0).toISOString(), cwd: "/fixture" },
	];
	let parentId: string | null = null;
	let serial = 0;
	const append = (message: AgentMessage) => {
		const id = `entry-${serial++}`;
		entries.push({ type: "message", id, parentId, timestamp: new Date(serial).toISOString(), message });
		parentId = id;
	};
	append({ role: "user", content: "setup ".repeat(30_000), timestamp: 0 });
	let tools = 0;
	for (let request = 0; request < 375; request++) {
		const toolTurn = request % 5 !== 4 && tools < 288;
		// A long eval-only gap leaves some of the last six clearable results
		// far behind the live tail when sporadic clearable results resume.
		const clearable = tools < 96 || (tools >= 210 && (tools - 210) % 7 === 0);
		const name = clearable ? ["read", "write", "edit"][tools % 3] : "eval";
		const tokens = request < 275 ? 1_435 : 815;
		const assistant: AssistantMessage = {
			role: "assistant",
			content: toolTurn
				? [{ type: "toolCall", id: `call-${request}`, name, arguments: { path: `file-${request}` } }]
				: [{ type: "text", text: "answer ".repeat(Math.floor((tokens * 4) / 7)) }],
			api: "faux-completion",
			provider: "faux",
			model: "cache-model",
			usage: { ...EMPTY_USAGE, input: 1 },
			stopReason: toolTurn ? "toolUse" : "stop",
			timestamp: request + 1,
		};
		append(assistant);
		if (toolTurn) {
			append({
				role: "toolResult",
				toolCallId: `call-${request}`,
				toolName: name,
				content: [{ type: "text", text: "result ".repeat(Math.floor((tokens * 4) / 7)) }],
				isError: false,
				timestamp: request + 1,
			});
			tools++;
		} else {
			append({ role: "user", content: "Continue.", timestamp: request + 1 });
		}
	}
	return entries;
}

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
	options: { contextWindow: number; fixedPrefixTokens: number; feedback: boolean },
) {
	const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const caches = new Map<string, Buffer>();
	const requests = new Map<
		string,
		{
			lineage: string;
			compaction: string;
			state: { engaged: boolean; cutIndex: number; prefixHash: string };
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
		const state = ancestor && !reset ? { ...ancestor.state } : { engaged: false, cutIndex: 0, prefixHash: "" };
		const beforeCut = state.cutIndex;
		const messages = buildSessionContext(entries, entry.parentId, byId).messages;
		const unreduced = estimateTotalTokens(messages) + options.fixedPrefixTokens;
		peakContext = Math.max(peakContext, unreduced);
		const previousUsage = ancestor?.usage ?? 0;
		const ctx = {
			model: undefined,
			sessionManager: { getBranch: () => branch },
			getContextUsage: () => ({ tokens: previousUsage, contextWindow: options.contextWindow }),
		} as ExtensionContext;
		const outgoing = buildCompactionContext({
			event: { type: "context", messages },
			ctx,
			contextWindow: options.contextWindow,
			promptContextWindow: options.contextWindow - 16_384,
			reductionCeilingTokens:
				Math.min(
					options.contextWindow - 40_000,
					options.contextWindow * computeEffectiveThreshold(options.contextWindow),
				) - options.fixedPrefixTokens,
			contextReductionState: state,
			contextOverheadTokens: options.fixedPrefixTokens,
			toolAdmissionEnabled: true,
			breakerFallback: false,
			laneOwnsCompaction: false,
			emergencyPruneLatch: createEmergencyPruneLatch(),
		});
		if (state.cutIndex !== beforeCut) frontierSteps++;
		const reduced = Reflect.has(contextReduction, "reduceContextWithFrontier")
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
		requests.set(entry.id, {
			lineage,
			compaction,
			state,
			children: 0,
			usage: options.feedback ? estimateTotalTokens(outgoing) + options.fixedPrefixTokens : recordedContext,
		});
		count++;
	}
	return {
		requests: count,
		peakUnreducedContextTokens: peakContext,
		peakRecordedContextTokens: options.feedback ? null : peakRecordedContext,
		frontierSteps,
		shapeChanges,
		cacheWriteTokens: cacheWrites,
		cacheWriteUsd: Math.round((cacheWrites / 1_000_000) * 12.5 * 100) / 100,
		priceUsdPerMillion: 12.5,
		tokenModel: "ceil(UTF-8 serialized suffix bytes / 4)",
		usageModel: options.feedback ? "estimated outgoing request feedback" : "recorded prior request usage",
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const value = (name: string) => args[args.indexOf(name) + 1];
	const synthetic = args.includes("--synthetic");
	const session = args.includes("--session") ? value("--session") : undefined;
	if (!synthetic && !session)
		throw new Error("Use --synthetic or --session <JSONL>; output contains aggregates only.");
	const entries = synthetic ? syntheticCacheSession() : parseSessionEntries(readFileSync(session ?? "", "utf8"));
	const options = {
		contextWindow: args.includes("--window") ? Number(value("--window")) : 1_000_000,
		fixedPrefixTokens: args.includes("--fixed-prefix-tokens") ? Number(value("--fixed-prefix-tokens")) : 52_600,
		feedback: synthetic,
	};
	if (args.includes("--compare-repo")) {
		// The baseline is intentionally selected at runtime; both runs consume
		// the same in-memory JSONL snapshot, even if the source session is live.
		const baseline: { replayContextCache: typeof replayContextCache } = await import(
			pathToFileURL(resolve(value("--compare-repo"), "packages/coding-agent/test/support/replay-context-cache.ts"))
				.href
		);
		console.log(
			JSON.stringify(
				{
					baseline: baseline.replayContextCache(entries, options),
					branch: replayContextCache(entries, options),
				},
				null,
				2,
			),
		);
	} else {
		console.log(JSON.stringify(replayContextCache(entries, options), null, 2));
	}
}
