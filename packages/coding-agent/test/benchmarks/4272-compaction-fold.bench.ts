import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompactContentIndex } from "../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../src/modes/rpc/compact-content-store.ts";
import { type CompactStorageIo, nodeCompactStorageIo } from "../../src/modes/rpc/compact-storage-io.ts";

// senpi#4272 / RULING-47 wall-time gate for the 8,192-row bulk fold (64 rounds). Run with plain node:
//   nice -n 10 node packages/coding-agent/test/benchmarks/4272-compaction-fold.bench.ts
// Each run is a fresh process that starts once the 5-minute load average is below 30 (waiting at most
// --max-wait-min, default 30, in total). Exit 0: every run qualified and the min of 5 is within budget;
// 1: a min over budget or a broken fold; 2: within budget but some runs started at load >= 30.

const COUNT = 8192;
const RUNS = 5;
const LOAD_LIMIT = 30;
const BUDGET_MS = { memory: 250, disk: 500 } as const;
type Kind = keyof typeof BUDGET_MS;
interface Run {
	readonly wallMs: number;
	readonly creates: number;
	readonly allocated: number;
	readonly rows: number;
	readonly failures: number;
}

function memoryIo(): CompactStorageIo {
	const files = new Map<string, Buffer>();
	return {
		async writeFile(path, data) {
			files.set(path, Buffer.from(data));
		},
		async readFile(path, range) {
			const data = files.get(path);
			if (!data) throw new Error(`missing ${path}`);
			return Buffer.from(range ? data.subarray(range.offset, range.offset + range.length) : data);
		},
		async unlink(path) {
			files.delete(path);
		},
	};
}

async function fold(kind: Kind): Promise<Run> {
	const root = await mkdtemp(join(tmpdir(), "senpi-fold-bench-"));
	const io = kind === "disk" ? nodeCompactStorageIo : memoryIo();
	let creates = 0;
	const store = new CompactContentStore({
		dir: join(root, "recovery", "epoch-1"),
		io: {
			...io,
			writeFile(path, data) {
				creates++;
				return io.writeFile(path, data);
			},
		},
	});
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	const compactor = index["compactor"];
	const schedule = compactor.schedule;
	try {
		compactor.schedule = () => undefined;
		for (let n = 0; n < COUNT; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		compactor.schedule = schedule;
		const before = { creates, allocated: index.bases.allocatedNodes };
		const started = performance.now();
		index.maybeCompact();
		await store.idle();
		const wallMs = performance.now() - started;
		const cut = index.freeze();
		const rows = (await index.entries(cut)).size;
		index.release(cut);
		const { failures } = store.status();
		return {
			wallMs,
			creates: creates - before.creates,
			allocated: index.bases.allocatedNodes - before.allocated,
			rows,
			failures: failures.length,
		};
	} finally {
		await store.retire();
		await rm(root, { recursive: true, force: true });
	}
}

async function child(kind: Kind): Promise<Run> {
	const run = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run", kind], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	let out = "";
	run.stdout.on("data", (data: Buffer) => {
		out += data.toString();
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		run.on("error", reject);
		run.on("exit", resolve);
	});
	if (code !== 0) throw new Error(`fold run exited with ${code}`);
	return JSON.parse(out) as Run;
}

async function settledLoad(deadline: number): Promise<number> {
	while (loadavg()[1] >= LOAD_LIMIT && Date.now() < deadline) await new Promise((done) => setTimeout(done, 15_000));
	return loadavg()[1];
}

const args = process.argv.slice(2);
if (args[0] === "--run") {
	process.stdout.write(JSON.stringify(await fold(args[1] === "disk" ? "disk" : "memory")));
} else {
	const wait = args.indexOf("--max-wait-min");
	const deadline = Date.now() + Number(wait < 0 ? 30 : args[wait + 1]) * 60_000;
	const results: Record<Kind, { run: Run; load: number }[]> = { memory: [], disk: [] };
	for (let rep = 0; rep < RUNS; rep++) {
		for (const kind of ["memory", "disk"] as const) {
			const load = await settledLoad(deadline);
			const run = await child(kind);
			results[kind].push({ run, load });
			console.log(
				`run ${rep + 1} ${kind}: ${run.wallMs.toFixed(0)} ms, load5 ${load.toFixed(1)}, creates ${run.creates}, allocated ${run.allocated}`,
			);
		}
	}
	let exitCode = 0;
	for (const kind of ["memory", "disk"] as const) {
		const runs = results[kind];
		const min = Math.min(...runs.map(({ run }) => run.wallMs));
		const qualified = runs.every(({ load }) => load < LOAD_LIMIT);
		const broken = runs.some(({ run }) => run.rows !== COUNT || run.failures > 0);
		const verdict = broken || min > BUDGET_MS[kind] ? "OVER" : qualified ? "PASS" : "LOAD";
		console.log(
			`FOLD_BENCH ${kind} min=${min.toFixed(0)}ms budget=${BUDGET_MS[kind]}ms runs=${runs.map(({ run }) => run.wallMs.toFixed(0)).join(",")} load5=${runs.map(({ load }) => load.toFixed(1)).join(",")} ${verdict}`,
		);
		if (verdict === "OVER") exitCode = 1;
		else if (verdict === "LOAD" && exitCode === 0) exitCode = 2;
	}
	process.exitCode = exitCode;
}
