// senpi#3968 session-open memory (benchmark, not a test gate). For each `--mb` size it writes a synthetic session
// (per turn: a prompt, a tool call, a 16 KiB tool result and an answer), then opens it in a fresh process with
// SessionManager.open and records that process's memory before the open, right after it, after a full read, and after an
// idle `--idle-s` seconds (default 60). Before idling it applies the host's settle rule
// (AgentSession.releaseSettledSessionMemory): the read views go when the store spilled strings or left them on disk.
// Every reading follows a full collection.
//
//   bun packages/coding-agent/test/benchmarks/3968-session-open-memory.ts --mb 10 --mb 100 --mb 500
//
// Run it from two checkouts (main and the PR) to compare. It prints one JSON line per size.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readOwnFootprint } from "../../src/core/process-footprint.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const runtime = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
if (runtime === undefined) throw new Error("run this benchmark with bun: it needs Bun.gc for a full collection");
const fullGc = (): void => runtime.gc(true);

const argv = process.argv.slice(2);
const values = (name: string) => argv.flatMap((arg, index) => (arg === `--${name}` ? [argv[index + 1] ?? ""] : []));
const RESULT_BYTES = 16 * 1024;
// `--realistic`: tool output shaped like a real read (escaped newlines, quotes, backslashes, non-ASCII), one body of
// 1-5 MB per turn, so the numbers are not a property of a fixture whose bodies need no unescaping.
const realistic = argv.includes("--realistic");
const realisticResult = (turn: number): string => {
	const line = `${turn}\tconst label = "tool \\"output\\""; // path C:\\work\\file-${turn}.ts — ü 한글\n`;
	return line.repeat(Math.ceil(((1 + (turn % 5)) * 1024 * 1024) / line.length));
};

function writeToolSession(dir: string, megabytes: number): string {
	const seed = SessionManager.create(dir, dir);
	seed.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	const file = seed.getSessionFile();
	if (file === undefined) throw new Error("the seed session has no file");
	const [header, seedLine] = readFileSync(file, "utf8").trim().split("\n");
	if (header === undefined || seedLine === undefined) throw new Error("the seed session file is incomplete");
	const seedEntry = JSON.parse(seedLine);
	const synthetic = "r".repeat(RESULT_BYTES);
	const lines = [header];
	let bytes = 0;
	let parentId: string | null = null;
	let next = 0;
	const push = (message: unknown) => {
		const id = (next++).toString(16).padStart(8, "0");
		const line = JSON.stringify({ ...seedEntry, id, parentId, message });
		lines.push(line);
		bytes += line.length + 1;
		parentId = id;
	};
	for (let turn = 0; bytes < megabytes * 1024 * 1024; turn++) {
		const callId = `call-${turn}`;
		const at = Date.now();
		push({ role: "user", content: `turn ${turn}: read the file`, timestamp: at });
		push({
			...seedEntry.message,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `file-${turn}.txt` } }],
			timestamp: at,
		});
		push({
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: realistic ? realisticResult(turn) : synthetic }],
			isError: false,
			timestamp: at,
		});
		push({
			...seedEntry.message,
			role: "assistant",
			content: [{ type: "text", text: `turn ${turn}: done` }],
			timestamp: at,
		});
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function reading() {
	fullGc();
	const usage = process.memoryUsage();
	const footprint = readOwnFootprint();
	return {
		footprint: footprint.bytes,
		measure: footprint.measure,
		rss: usage.rss,
		heapUsed: usage.heapUsed,
		heapTotal: usage.heapTotal,
		external: usage.external,
		arrayBuffers: usage.arrayBuffers,
	};
}

async function child(file: string, idleSeconds: number): Promise<void> {
	const before = reading();
	const manager = SessionManager.open(file);
	const afterOpen = reading();
	const entries = manager.getEntries().length;
	const afterRead = reading();
	const stats = manager.getResidentStoreStats();
	if ((stats.evictedCount ?? 0) > 0 || (stats.pagedCount ?? 0) > 0) manager.dropMaterializedCaches();
	await sleep(idleSeconds * 1000);
	const afterIdle = reading();
	// Keeps the session reachable through every reading, so nothing measured is collectable.
	if (manager.getEntries().length !== entries) throw new Error("the session changed while idle");
	process.stdout.write(`${JSON.stringify({ entries, before, afterOpen, afterRead, afterIdle })}\n`);
}

const childFile = values("child")[0];
if (childFile !== undefined) {
	await child(childFile, Number(values("idle-s")[0] ?? "60"));
} else {
	const sizes = values("mb").map(Number);
	const idle = values("idle-s")[0] ?? "60";
	const root = realpathSync(mkdtempSync(join(tmpdir(), "s3968-bench-")));
	try {
		for (const megabytes of sizes.length > 0 ? sizes : [10, 100, 500]) {
			const dir = join(root, `${megabytes}mb`);
			mkdirSync(dir);
			const file = writeToolSession(dir, megabytes);
			const run = spawnSync(process.execPath, [import.meta.filename, "--child", file, "--idle-s", idle], {
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			});
			if (run.status !== 0) throw new Error(`the ${megabytes} MB child failed: ${run.stderr}`);
			const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
			process.stdout.write(
				`${JSON.stringify({ megabytes, realistic, fileBytes: statSync(file).size, ...result })}\n`,
			);
			rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
