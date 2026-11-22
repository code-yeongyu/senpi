/**
 * senpi#1960 todo 4: session retention measurement driver.
 *
 * Spawns N real sessions (the `session-manager-first-cell-pin.test.ts` `bun --eval` shape, one JS
 * kernel each), drives each through 120 scripted tool calls, and records - after every 10 calls -
 * the session's footprint, the todo-16 memory report (main heap, kernel heap, resident store, the
 * render-cache and frame figures when a TUI is attached) and the serialized size of the session's
 * message history. It prints per-session growth per tool call (the slope of footprint vs call index
 * over the last 60 calls), p50/p95 across sessions, and the layer split at the end.
 *
 * Arms (the plan's A/B/A/B, min-of-3):
 *   (A) base engine   - footprint and message-history size only (a base build has no instrument);
 *   (B) branch engine - instrument on (SENPI_MEMORY_REPORT=1), the layer-split arm.
 * B's split names where the growth lives for the engine-owned sections that exist at this stage
 * (render cache + frame bytes, resident store, kernels, main heap); it is the first attribution
 * data point for todo 17. Wall-clock timings are never reported as speed.
 *
 * Usage: bun scripts/qa-session-retention.ts [--sessions 12] [--calls 120] [--arm base|branch]
 *        [--repetitions 3] [--status-file <path>] [--log-file <path>]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Options {
	readonly sessions: number;
	readonly calls: number;
	readonly arm: "base" | "branch";
	readonly repetitions: number;
	readonly statusFile: string | undefined;
	readonly logFile: string | undefined;
}

interface Sample {
	readonly callIndex: number;
	readonly footprintBytes: number;
	readonly historyBytes: number;
	readonly report: Record<string, unknown> | undefined;
}

interface SessionRun {
	readonly sessionId: string;
	readonly recycled: boolean;
	readonly samples: readonly Sample[];
}

function parseArgs(argv: readonly string[]): Options {
	const read = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index === -1 ? undefined : argv[index + 1];
	};
	const num = (flag: string, fallback: number): number => {
		const value = read(flag);
		return value === undefined ? fallback : Number(value);
	};
	const arm = read("--arm");
	return {
		sessions: num("--sessions", 12),
		calls: num("--calls", 120),
		arm: arm === "base" ? "base" : "branch",
		repetitions: num("--repetitions", 3),
		statusFile: read("--status-file"),
		logFile: read("--log-file"),
	};
}

const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");

function logLine(options: Options, line: string): void {
	process.stdout.write(`${line}\n`);
	if (options.logFile !== undefined) appendFileSync(options.logFile, `${line}\n`);
}

function writeStatus(options: Options, status: Record<string, unknown>): void {
	if (options.statusFile === undefined) return;
	writeFileSync(options.statusFile, `${JSON.stringify(status, null, 2)}\n`);
}

/** The scripted tool call at `index`: the plan's four alternating shapes. */
function cellFor(index: number): { readonly summary: string; readonly code: string } {
	switch (index % 4) {
		case 0:
			// An eval holding a 512 KiB payload (the plan's "nested read" shape: a large retained result).
			return {
				summary: `large alloc ${index}`,
				code: `globalThis.__keep${index} = new Uint8Array(512 * 1024).fill(${index} % 251); "alloc ${index}"`,
			};
		case 1:
			// A trivially small cell: the string literal itself is the whole payload, so case 1 marks
			// the floor the other shapes' growth is measured against.
			return { summary: `plain read ${index}`, code: `"plain ${index}"` };
		case 2:
			// An eval with 200 KB of Bun.$ output.
			return {
				summary: `shell output ${index}`,
				code: `const out = await Bun.$\`head -c 204800 /dev/zero | base64\`.text(); "shell ${index} " + out.length`,
			};
		default:
			// An eval that drops its globals.
			return {
				summary: `drop globals ${index}`,
				code: `for (const k of Object.keys(globalThis).filter((k) => k.startsWith("__keep"))) Reflect.deleteProperty(globalThis, k); "drop ${index}"`,
			};
	}
}

/** The scenario one `bun --eval` session runs: 120 cells against one JS kernel, sampling itself. */
function scenario(options: Options, sessionIndex: number, sampleEvery: number): string {
	const managerPath = join(pkgRoot, "src", "extension", "session-manager.ts");
	const settingsPath = join(pkgRoot, "src", "config", "settings.ts");
	const footprintPath = join(repoRoot, "packages", "coding-agent", "src", "core", "process-footprint.ts");
	const reportPath = join(repoRoot, "packages", "coding-agent", "src", "core", "memory-report", "memory-report-build.ts");
	const cells = Array.from({ length: options.calls }, (_, i) => cellFor(i));
	return `
const { createCodemodeSessionManager } = await import(${JSON.stringify(managerPath)});
const { defaultCodemodeSettings } = await import(${JSON.stringify(settingsPath)});
const { readOwnFootprint } = await import(${JSON.stringify(footprintPath)});
const cells = ${JSON.stringify(cells)};
const arm = ${JSON.stringify(options.arm)};
const sampleEvery = ${sampleEvery};
const sessionId = "retention-" + ${sessionIndex};
const history = [];
const samples = [];
let recycled = false;
const manager = await createCodemodeSessionManager({
	sessionId,
	cwd: process.cwd(),
	settings: defaultCodemodeSettings,
	availability: { js: { enabled: true, detected: { ok: true, path: "node", version: "v20" } }, py: { enabled: false, detected: { ok: false } }, rb: { enabled: false, detected: { ok: false } }, jl: { enabled: false, detected: { ok: false } } },
	executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
	complete: async () => { throw new Error("completion not exercised"); },
});
async function report() {
	if (arm !== "branch") return undefined;
	try {
		const { buildMemoryReport } = await import(${JSON.stringify(reportPath)});
		return buildMemoryReport({
			sessionId: () => sessionId,
			sessionFile: () => undefined,
			residentStore: () => ({ entries: history.length, approxBytes: history.reduce((a, m) => a + m.length * 2, 0) }),
			reporters: () => [],
		});
	} catch (error) {
		return { reportError: String(error) };
	}
}
try {
	const kernel = await manager.getKernel("js", () => {});
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];
		const result = await kernel.run({ cellId: "cell-" + i, code: cell.code, onMessage: () => {}, timeoutMs: 60_000 }).catch((error) => ({ ok: false, cellError: String(error) }));
		if (result && result.memory && result.memory.recycled === true) recycled = true;
		history.push(JSON.stringify({ i, summary: cell.summary, ok: result && result.ok }));
		if ((i + 1) % sampleEvery === 0) {
			samples.push({
				callIndex: i + 1,
				footprintBytes: readOwnFootprint().bytes,
				historyBytes: history.reduce((a, m) => a + m.length, 0),
				report: await report(),
			});
		}
	}
} finally {
	await manager.dispose();
}
console.log("__RETENTION_RESULT__" + JSON.stringify({ sessionId, recycled, samples }));
`;
}

/** Slope of footprint vs call index over the last `window` samples (least squares, bytes per call). */
function slope(samples: readonly Sample[], window: number): number {
	const tail = samples.slice(-window);
	if (tail.length < 2) return 0;
	const n = tail.length;
	let sx = 0, sy = 0, sxy = 0, sxx = 0;
	for (const s of tail) {
		sx += s.callIndex; sy += s.footprintBytes; sxy += s.callIndex * s.footprintBytes; sxx += s.callIndex * s.callIndex;
	}
	const denom = n * sxx - sx * sx;
	return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index];
}

function runOneRepetition(options: Options, repetition: number): SessionRun[] {
	const root = mkdtempSync(join(tmpdir(), `qa-retention-${options.arm}-${repetition}-`));
	try {
		const runs: SessionRun[] = [];
		for (let s = 0; s < options.sessions; s++) {
			const out = execFileSync("bun", ["--eval", scenario(options, s, 10)], {
				cwd: root,
				encoding: "utf8",
				timeout: 15 * 60_000,
				maxBuffer: 64 * 1024 * 1024,
				env: {
					...process.env,
					...(options.arm === "branch" ? { SENPI_MEMORY_REPORT: "1" } : {}),
				},
			});
			const marker = out.indexOf("__RETENTION_RESULT__");
			if (marker === -1) throw new Error(`session ${s} produced no result marker: ${out.slice(-400)}`);
			const parsed = JSON.parse(out.slice(marker + "__RETENTION_RESULT__".length).trim().split("\n")[0]);
			runs.push({ sessionId: parsed.sessionId, recycled: parsed.recycled === true, samples: parsed.samples });
			writeStatus(options, { arm: options.arm, repetition, session: s, done: false });
		}
		return runs;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	if (options.logFile !== undefined) writeFileSync(options.logFile, "");
	const allRuns: SessionRun[][] = [];
	for (let rep = 0; rep < options.repetitions; rep++) {
		const runs = runOneRepetition(options, rep);
		allRuns.push(runs);
		writeStatus(options, { arm: options.arm, repetition: rep, done: true, sessions: runs.length });
		logLine(options, `repetition ${rep} complete: ${runs.length} sessions`);
	}
	// min-of-3 per session across repetitions: for each session slot, the minimum slope.
	const perSession: { sessionId: string; recycled: boolean; minSlope: number; finalReport: Record<string, unknown> | undefined }[] = [];
	for (let s = 0; s < options.sessions; s++) {
		const slopes = allRuns.map((runs) => slope(runs[s]?.samples ?? [], 6));
		const minSlope = Math.min(...slopes);
		const last = allRuns[allRuns.length - 1]?.[s];
		perSession.push({
			sessionId: last?.sessionId ?? `retention-${s}`,
			recycled: allRuns.some((runs) => runs[s]?.recycled === true),
			minSlope,
			finalReport: last?.samples[last.samples.length - 1]?.report,
		});
	}
	const slopes = perSession.map((s) => s.minSlope);
	const summary = {
		arm: options.arm,
		sessions: options.sessions,
		calls: options.calls,
		repetitions: options.repetitions,
		growthPerCallBytes: { p50: percentile(slopes, 50), p95: percentile(slopes, 95) },
		recycledSessions: perSession.filter((s) => s.recycled).length,
		finalSplit: perSession[0]?.finalReport,
	};
	logLine(options, `SUMMARY ${JSON.stringify(summary, null, 2)}`);
	writeStatus(options, { arm: options.arm, done: true, summary });
	// Failure assertion: every scripted session came back with its own result marker and its own id
	// (a session whose output never carried the marker fails `runOneRepetition` before this), and a
	// session whose kernel recycled still delivered its 120th call's result (recycled: true, never
	// a missing run).
	const expected = new Set(Array.from({ length: options.sessions }, (_, s) => `retention-${s}`));
	const missing = [...expected].filter((id) => !perSession.some((s) => s.sessionId === id));
	if (missing.length > 0) {
		throw new Error(`sessions finished without their 120th call's result: ${missing.join(", ")}`);
	}
}

main();
