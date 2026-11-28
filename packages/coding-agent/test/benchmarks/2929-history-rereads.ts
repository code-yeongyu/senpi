// Run under Bun with a temporary HOME and PI_OFFLINE=1. All turns use the in-process faux provider.
import {
	createReadStream,
	closeSync,
	mkdtempSync,
	openSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { loadEntriesFromFile, SessionLineSplitter } from "../../src/core/session-entry-file.ts";
import { SessionManager, setSessionEntryLoaderForTesting } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { writeCompactedTranscript } from "./3519-compacted-transcript.ts";

export async function writeHistoryRereadTranscript(dir: string, mb: number): Promise<string> {
	const original = writeCompactedTranscript(dir, mb);
	const file = join(dir, "bookkept.jsonl");
	const fd = openSync(file, "wx");
	let parentId: string | null = null;
	let sessionId = "";
	let seq = 0;
	const lines = createInterface({ input: createReadStream(original), crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			const entry = JSON.parse(line);
			if (entry.type === "session") {
				sessionId = crypto.randomUUID();
				writeSync(fd, JSON.stringify({ ...entry, id: sessionId }) + "\n");
				continue;
			}
			entry.parentId = parentId;
			parentId = entry.id;
			writeSync(fd, JSON.stringify(entry) + "\n");
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const lifecycle = {
				sessionId,
				rootSessionId: sessionId,
				seq: ++seq,
				epoch: seq,
				role: "root",
				state: "done",
				epochOrigin: "human",
				humanInputRevision: seq,
				selfSettleEligible: false,
				runPaused: false,
				since: entry.timestamp,
				epochSealed: true,
				runActive: false,
				interrupted: false,
			};
			const custody = { id: `ticket-${seq}`, key: `delivery-${seq}`, kind: "background", state: "settled" };
			for (const [customType, data] of [
				["session-lifecycle", lifecycle],
				["work-custody", custody],
			] as const) {
				const id = `${customType}-${seq}`;
				writeSync(
					fd,
					JSON.stringify({ type: "custom", id, parentId, timestamp: entry.timestamp, customType, data }) + "\n",
				);
				parentId = id;
			}
		}
	} finally {
		closeSync(fd);
	}
	return file;
}

async function run(mb: number) {
	const dir = mkdtempSync(join(tmpdir(), "history-rereads-"));
	let harness: Harness | undefined;
	const file = await writeHistoryRereadTranscript(dir, mb);
	if (process.argv.includes("--without-ttsr")) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["ttsr"] }));
	}
	const sizeMiB = statSync(file).size / 1048576;
	// Both full-entry loaders finish a SessionLineSplitter. Count at EOF, excluding the
	// bounded header and journal readers which use the same splitter for a different job.
	const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	const header = (await input[Symbol.asyncIterator]().next()).value;
	input.close();
	if (header === undefined) throw new Error("Generated transcript has no header");
	const targetReaders = new WeakSet<SessionLineSplitter>();
	const push = SessionLineSplitter.prototype.push;
	SessionLineSplitter.prototype.push = function (chunk) {
		if (chunk[0] === 123 && chunk.subarray(0, Buffer.byteLength(header) + 1).toString() === header + "\n")
			targetReaders.add(this);
		return push.call(this, chunk);
	};
	const finish = SessionLineSplitter.prototype.finish;
	let sync = 0;
	let sliced = 0;
	SessionLineSplitter.prototype.finish = function () {
		if (!targetReaders.has(this)) return finish.call(this);
		const stack = new Error().stack ?? "";
		if (process.env.BENCH_TRACE) console.error(stack);
		if (stack.includes("loadEntriesFromFileAsync")) sliced++;
		else if (stack.includes("readRawEntriesFromFile")) sync++;
		return finish.call(this);
	};
	let rereads = 0;
	let reducers = 0;
	const restore = setSessionEntryLoaderForTesting((...args) => {
		rereads++;
		if (new Error().stack?.includes("_readWholeHistory")) reducers++;
		return loadEntriesFromFile(...args);
	});
	async function phase(name: string, work: () => Promise<void>) {
		sync = 0;
		sliced = 0;
		rereads = 0;
		reducers = 0;
		const started = performance.now();
		await work();
		const wallMs = performance.now() - started;
		(globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc(true);
		if (sync < rereads) throw new Error("Full-history reads were not counted");
		console.log(
			JSON.stringify({
				phase: name,
				transcriptMiB: +sizeMiB.toFixed(1),
				loaderCalls: sync + sliced,
				fullHistoryRereads: rereads,
				reducerRereads: reducers,
				wallMs: +wallMs.toFixed(1),
				rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1),
			}),
		);
	}
	try {
		await phase("open", async () => {
			const manager = await SessionManager.openAsync(file, dir, dir);
			if (sliced !== 1) throw new Error(`Async open counted ${sliced} sliced and ${sync} sync loads`);
			const resources = new DefaultResourceLoader({ cwd: dir, agentDir: dir });
			await resources.reload();
			harness = await createHarness({
				cwd: dir,
				sessionManager: manager,
				resourceLoader: resources,
				settings: { compaction: { enabled: false } },
			});
			await harness.session.bindExtensions({ mode: "rpc" });
		});
		if (!harness) throw new Error("Session did not open");
		const active: Harness = harness;
		const turn = async () => {
			active.setResponses([fauxAssistantMessage("Complete.")]);
			await active.session.prompt("Answer briefly.");
			await active.session.waitForIdle();
			if (active.getPendingResponseCount() !== 0) throw new Error("The turn did not consume its faux response");
		};
		await phase("first turn", turn);
		await phase("settle idle", async () => {
			active.session.releaseSettledSessionMemory();
		});
		await phase("reload", async () => {
			const result = await active.session.reload();
			if (result.cancelled) throw new Error(result.reason);
		});
		await phase("next turn", turn);
	} finally {
		restore();
		SessionLineSplitter.prototype.finish = finish;
		SessionLineSplitter.prototype.push = push;
		harness?.cleanup();
		await harness?.session.whenToolChildClosed();
		rmSync(dir, { recursive: true, force: true });
	}
}
if (process.argv[1] === import.meta.filename) {
	await run(Number(process.argv[2] ?? 16));
	// The process-wide extension services outlive the harness, as in 2537-stream-heap.ts.
	process.exit(0);
}
