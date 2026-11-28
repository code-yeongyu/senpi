// senpi#7596 resident bookkeeping measurement (benchmark, not a test gate). A child process writes a compacted
// session whose turns each leave lifecycle bookkeeping behind; this process reopens it and prints what stays
// resident: the entries a branch read walks, the entries the lifecycle fold holds, the heap after a full collection,
// and the context build time.
//
//   bun packages/coding-agent/test/benchmarks/7596-resident-bookkeeping.ts --turns 4000
//
// Run it from two checkouts (main and the PR) to compare; the numbers depend on the transcript, not the machine.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifecycleHistory } from "../../src/core/lifecycle-history.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type BookkeptTranscript, writeBookkeptTranscript } from "./7596-bookkept-transcript.ts";

const runtime = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
if (runtime === undefined) throw new Error("run this benchmark with bun: it needs Bun.gc for a full collection");
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const at = argv.indexOf(`--${name}`);
	return at < 0 ? undefined : argv[at + 1];
};
const turns = Number(option("turns") ?? "4000");
const megabytes = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const collect = () => {
	runtime.gc(true);
	return process.memoryUsage().heapUsed;
};

const writeInto = option("write");
if (writeInto !== undefined) {
	// The writer's own mirror must not be in the process that measures, so it runs here and exits.
	console.log(JSON.stringify(writeBookkeptTranscript(writeInto, turns)));
} else {
	const dir = mkdtempSync(join(tmpdir(), "s7596-bench-"));
	try {
		const writer = spawnSync(process.execPath, [import.meta.filename, "--write", dir, "--turns", String(turns)], {
			encoding: "utf8",
		});
		if (writer.status !== 0) throw new Error(`the transcript writer failed: ${writer.stderr}`);
		const written: BookkeptTranscript = JSON.parse(writer.stdout);
		const empty = collect();
		const openStarted = performance.now();
		const manager = SessionManager.open(written.file, dir);
		const openMs = performance.now() - openStarted;
		const branchEntries = manager.getBranch().length;
		const foldedEntries = manager.reduceHistory(lifecycleHistory).length;
		manager.dropMaterializedCaches();
		const residentHeap = collect() - empty;
		const rounds = 20;
		let contextMessages = 0;
		const contextStarted = performance.now();
		for (let round = 0; round < rounds; round++) {
			manager.dropMaterializedCaches();
			contextMessages = manager.buildSessionContext().messages.length;
		}
		const contextMs = (performance.now() - contextStarted) / rounds;
		console.log(
			JSON.stringify({
				turns,
				fileMb: megabytes(statSync(written.file).size),
				entries: manager.getEntryCount(),
				bookkeepingBeforeWindow: written.beforeWindow,
				openMs: Math.round(openMs),
				branchEntries,
				foldedEntries,
				residentHeapMb: megabytes(residentHeap),
				contextMessages,
				contextBuildMs: Math.round(contextMs * 100) / 100,
			}),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
