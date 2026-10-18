/**
 * Body of context-hook-pipeline.bench.mjs (senpi#2525).
 *
 * Measures one `ExtensionRunner.emitContext` pass — the per-turn clone plus the
 * builtin compaction/tool-search context pipeline — over a fixed synthetic
 * transcript of 10,000 uncompacted messages (~2.7M estimated tokens, mirroring
 * the issue's reproduction). The same array is reused across runs, matching a
 * real session where the transcript keeps identity between turns.
 *
 * Deterministic: fixed-seed content, fixed message count, median of 5 timed
 * runs after one warmup. Prints one JSON object with the runs, the median, the
 * machine load average, and the checked-out HEAD so before/after numbers bind
 * to an exact source state. No assertions; this is a probe, not a gate.
 */

import { spawnSync } from "node:child_process";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import toolSearchExtension from "../../src/core/extensions/builtin/tool-search/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness } from "../suite/harness.ts";

const MESSAGE_COUNT = 10_000;
const TIMED_RUNS = 5;
// A 4M-window model keeps the synthetic 2.7M-token transcript under every
// prune/reduction threshold, so the measurement isolates the per-turn clone and
// estimate walks the issue profiles (the state windows will grow into).
const BENCH_CONTEXT_WINDOW = 4_000_000;
const BENCH_MAX_TOKENS = 32_000;

function createRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

function sizedText(rng: () => number, corpus: string, targetChars: number): string {
	const start = Math.floor(rng() * (corpus.length - 1));
	let text = "";
	while (text.length < targetChars) {
		text += corpus.slice((start + text.length) % corpus.length);
	}
	return text.slice(0, targetChars);
}

function buildSyntheticTranscript(): AgentMessage[] {
	const rng = createRng(2_525);
	const corpus = "The quick brown fox jumps over the lazy dog while the agent reads files and runs commands. ".repeat(
		80,
	);
	const messages: AgentMessage[] = [];
	// ~1,080 chars/message on average ~= 270 estimated tokens, so 10k messages
	// sit at ~2.7M tokens: the issue's uncompacted-session shape.
	for (let index = 0; index < MESSAGE_COUNT; index += 1) {
		const timestamp = 1_700_000_000_000 + index;
		const size = 600 + Math.floor(rng() * 960);
		switch (index % 4) {
			case 0:
				messages.push({
					role: "user",
					content: [{ type: "text", text: sizedText(rng, corpus, size) }],
					timestamp,
				});
				break;
			case 1:
				messages.push({
					role: "assistant",
					content: [
						{ type: "text", text: sizedText(rng, corpus, Math.floor(size / 3)) },
						{
							type: "toolCall",
							id: `call-${index}`,
							name: "read",
							arguments: { path: `/src/file-${index}.ts` },
						},
					],
					api: "openai-completions",
					provider: "faux",
					model: "bench-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp,
				} as AgentMessage);
				break;
			case 2:
				messages.push({
					role: "toolResult",
					toolCallId: `call-${index - 1}`,
					toolName: "read",
					content: [{ type: "text", text: sizedText(rng, corpus, size * 2) }],
					isError: false,
					timestamp,
				} as AgentMessage);
				break;
			default:
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: sizedText(rng, corpus, size) }],
					api: "openai-completions",
					provider: "faux",
					model: "bench-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp,
				} as AgentMessage);
				break;
		}
	}
	return messages;
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export async function runContextHookPipelineBench(args: string[]): Promise<void> {
	// `--undeclared` adds one handler without `mutatesMessages: false`: the clone path every
	// third-party `context` extension keeps (review of senpi#2884, M1).
	const undeclared = args.includes("--undeclared");
	const messages = buildSyntheticTranscript();
	const harness = await createHarness({
		models: [{ id: "bench-model", contextWindow: BENCH_CONTEXT_WINDOW, maxTokens: BENCH_MAX_TOKENS }],
		// The only two builtin `context` handlers; every other builtin adds zero
		// handlers to this pipeline, so the measured path is the full one.
		extensionFactories: [
			{ name: "compaction", factory: compactionExtension },
			{ name: "tool-search", factory: toolSearchExtension },
			...(undeclared
				? [{ name: "undeclared", factory: (pi: ExtensionAPI) => pi.on("context", () => undefined) }]
				: []),
		],
	});
	try {
		const runner = harness.getExtensionRunner();
		const estimate = estimateContextTokens(messages);
		// One warmup run: JIT, module-level lazy state, first catalog scan.
		await runner.emitContext(messages);
		const runsMs: number[] = [];
		for (let run = 0; run < TIMED_RUNS; run += 1) {
			const started = performance.now();
			await runner.emitContext(messages);
			runsMs.push(performance.now() - started);
		}
		const git = spawnSync("git", ["rev-parse", "HEAD"]);
		const head = git.status === 0 ? git.stdout.toString().trim() : "unknown";
		const report = {
			benchmark: "emitContext + context pipeline, 10k uncompacted messages (senpi#2525)",
			undeclaredHandler: undeclared,
			head,
			messages: MESSAGE_COUNT,
			estimatedTokens: estimate.tokens,
			runsMs: runsMs.map((ms) => Math.round(ms * 100) / 100),
			medianMs: Math.round(median(runsMs) * 100) / 100,
			loadavg: loadavg(),
		};
		console.log(JSON.stringify(report, null, 2));
	} finally {
		harness.cleanup();
	}
}
