// senpi#2537 stream heap measurement (benchmark, not a test gate). Opens a generated compacted transcript of `--mb` MB
// in an AgentSession, then runs `--turns` engine-triggered turns back to back: each turn queues the next hidden
// notice while it runs, so the session never settles idle, like a monitor streaming events. Every `--every` turns
// it records the heap after a full GC and whether the session manager holds a full-history view; at the end it
// records the heap after the idle release, which drops every materialized view.
//
//   bun packages/coding-agent/test/benchmarks/2537-stream-heap.ts --mb 20 --turns 1000 --every 100
//
// Run it from two checkouts (main and the PR) to compare.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "../suite/harness.ts";
import { writeCompactedTranscript } from "./3519-compacted-transcript.ts";

const runtime = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
if (runtime === undefined) throw new Error("run this benchmark with bun: it needs Bun.gc for a full collection");
const fullGc = (): void => runtime.gc(true);

const argv = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? Number(argv[index + 1]) : fallback;
};
const megabytes = option("mb", 20);
const turnsWanted = option("turns", 1000);
const every = option("every", 100);

const dir = mkdtempSync(join(tmpdir(), "s2537-bench-"));
const sessionManager = SessionManager.open(writeCompactedTranscript(dir, megabytes), dir, dir);
sessionManager.dropMaterializedCaches();
const harness = await createHarness({ sessionManager, settings: { compaction: { enabled: false } } });

let turns = 0;
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
// The faux provider logs every request's context for test assertions; this stream retains nothing.
harness.agent.streamFunction = (model: Model<string>) => {
	const stream = createAssistantMessageEventStream();
	const text = `Noted event batch ${turns}. The build for module ${turns % 17} finished without new warnings.`;
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
};

type Sample = { readonly turns: number; readonly heapMB: number; readonly holdsHistoryView: boolean };
const samples: Sample[] = [];
const sample = (): void => {
	fullGc();
	const heapMB = Number((process.memoryUsage().heapUsed / 1e6).toFixed(1));
	samples.push({ turns, heapMB, holdsHistoryView: sessionManager.holdsMaterializedHistory() });
};
const queueNext = (): void => {
	turns++;
	void harness.session.sendCustomMessage(
		{ customType: "bench-monitor", content: `[monitor] event ${turns}: CI check finished`, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
};
harness.session.subscribe((event) => {
	harness.events.length = 0;
	if (event.type !== "turn_start") return;
	if (turns % every === 0) sample();
	if (turns < turnsWanted) queueNext();
});

queueNext();
while (turns < turnsWanted || harness.session.isStreaming) await harness.session.waitForIdle();
harness.session.releaseSettledSessionMemory();
fullGc();
const afterIdleMB = Number((process.memoryUsage().heapUsed / 1e6).toFixed(1));
console.log(JSON.stringify({ megabytes, turns, samples, afterIdleReleaseMB: afterIdleMB }, null, 1));
harness.cleanup();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
