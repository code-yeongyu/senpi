#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, loadavg } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ITERATIONS = 20;
const CONCURRENCY = 4;
const SMALL_DIR_CASE_ID = "small-dir";
const MEDIUM_MAX_COUNT_CASE_ID = "medium-maxCount-100";
const SMALL_DIR_MIN_SPEEDUP = 1.5;
const MEDIUM_MAX_COUNT_MIN_SPEEDUP = 2;

export function evaluateGrepBenchGate(report) {
	const failures = [];
	if (!report || !Array.isArray(report.cases)) {
		return { ok: false, failures: ["bench report missing cases[]"] };
	}
	const byId = new Map(report.cases.map((entry) => [entry.id, entry]));

	const requireSpeedup = (caseId, minRatio) => {
		const entry = byId.get(caseId);
		if (!entry) {
			failures.push(`${caseId}: missing from report`);
			return;
		}
		const nativeMs = entry.native?.sequentialMinMs;
		const rgMs = entry.rg?.sequentialMinMs;
		if (!(nativeMs > 0) || !(rgMs > 0)) {
			failures.push(`${caseId}: sequential min-of-20 times must be positive`);
			return;
		}
		const ratio = rgMs / nativeMs;
		if (ratio < minRatio) {
			failures.push(
				`${caseId}: native min-of-20 is ${ratio.toFixed(2)}x vs rg, need >= ${minRatio.toFixed(1)}x`,
			);
		}
	};

	requireSpeedup(SMALL_DIR_CASE_ID, SMALL_DIR_MIN_SPEEDUP);
	requireSpeedup(MEDIUM_MAX_COUNT_CASE_ID, MEDIUM_MAX_COUNT_MIN_SPEEDUP);

	for (const entry of report.cases) {
		const capped = Boolean(entry.maxCount) || Boolean(entry.capped);
		const mode = entry.mode ?? "content";
		if (mode !== "content" || capped) continue;
		const nativeMatches = entry.native?.matches;
		const rgMatches = entry.rg?.matches;
		if (nativeMatches !== rgMatches) {
			failures.push(`${entry.id}: match counts disagree (native=${nativeMatches} rg=${rgMatches}, need +/- 0)`);
		}
	}

	return { ok: failures.length === 0, failures };
}

function repoRootFromScript() {
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveNativeAddon(repoRoot) {
	const host = `${process.platform}-${process.arch}`;
	const candidates = [
		process.env.SENPI_GREP_NATIVE_PATH,
		join(repoRoot, "packages", "coding-agent", "native", "prebuilds", host, `senpi_grep.${host}.node`),
		join(repoRoot, "crates", "senpi-grep", `senpi_grep.${host}.node`),
		join(repoRoot, "crates", "senpi-grep", `senpi_grep.${host}-gnu.node`),
		join(repoRoot, "crates", "senpi-grep", `senpi_grep.${host}-msvc.node`),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("native senpi_grep addon not found; run bun scripts/build-native-grep-local.mjs");
}

function commandVersion(bin) {
	const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
	return (result.stdout || result.stderr || "").trim().split("\n")[0] ?? "";
}

function benchCases(repoRoot) {
	return [
		{
			id: SMALL_DIR_CASE_ID,
			name: "small dir tools/*.ts export",
			path: join(repoRoot, "packages", "coding-agent", "src", "core", "tools"),
			pattern: "export",
			glob: "*.ts",
		},
		{
			id: "medium",
			name: "medium src/*.ts import",
			path: join(repoRoot, "packages", "coding-agent", "src"),
			pattern: "import",
			glob: "*.ts",
		},
		{
			id: MEDIUM_MAX_COUNT_CASE_ID,
			name: "medium src/*.ts import maxCount=100",
			path: join(repoRoot, "packages", "coding-agent", "src"),
			pattern: "import",
			glob: "*.ts",
			maxCount: 100,
		},
		{
			id: "repo-rare-literal",
			name: "repo-wide literal temporarilyDisabledToolNames",
			path: repoRoot,
			pattern: "temporarilyDisabledToolNames",
			literal: true,
		},
		{
			id: "repo-TODO-maxCount-100",
			name: "repo-wide TODO maxCount=100",
			path: repoRoot,
			pattern: "TODO",
			maxCount: 100,
		},
	];
}

function runRg({ pattern, searchPath, glob, literal, maxCount }) {
	return new Promise((resolveResult, reject) => {
		const args = ["--json", "--line-number", "--color=never", "--hidden"];
		if (literal) args.push("--fixed-strings");
		if (glob) args.push("--glob", glob);
		args.push("--", pattern, searchPath);
		const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		let matchCount = 0;
		let stderr = "";
		let killedDueToLimit = false;
		const cap = maxCount ?? Number.POSITIVE_INFINITY;
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		// Parse JSON match events and stop counting at the cap, same as
		// tools/grep.ts:237-320. SIGTERM at the cap is also what grep.ts does;
		// the timed run still kills so the child cannot outlive the cap, and
		// close treats that as success (killedDueToLimit).
		rl.on("line", (line) => {
			if (!line.trim() || matchCount >= cap) return;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "match") {
				matchCount++;
				if (Number.isFinite(cap) && matchCount >= cap) {
					killedDueToLimit = true;
					if (!child.killed) child.kill();
				}
			}
		});
		child.on("error", (error) => {
			rl.close();
			reject(error);
		});
		child.on("close", (code) => {
			rl.close();
			if (!killedDueToLimit && code !== 0 && code !== 1) {
				reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
				return;
			}
			resolveResult({ matches: matchCount });
		});
	});
}

async function runNative(native, { pattern, searchPath, cwd, glob, literal, maxCount }) {
	const result = await native.grep({
		pattern,
		paths: [searchPath],
		cwd,
		glob: glob ? [glob] : undefined,
		literal: literal || undefined,
		hidden: true,
		gitignore: true,
		maxCount,
		mode: "content",
	});
	const matches = result.counts?.matches ?? result.matches.filter((row) => !row.isContext).length;
	return { matches };
}

async function minOf(n, fn) {
	let minMs = Number.POSITIVE_INFINITY;
	let last;
	for (let i = 0; i < n; i++) {
		const started = performance.now();
		last = await fn();
		const ms = performance.now() - started;
		if (ms < minMs) minMs = ms;
	}
	return { minMs, last };
}

async function minOfConcurrent(n, concurrency, fn) {
	let minMs = Number.POSITIVE_INFINITY;
	for (let i = 0; i < n; i++) {
		const started = performance.now();
		await Promise.all(Array.from({ length: concurrency }, () => fn()));
		const ms = performance.now() - started;
		if (ms < minMs) minMs = ms;
	}
	return { minMs };
}

function renderMarkdownTable(report) {
	const lines = [
		`| case | native seq (min-of-${report.iterations}) ms | rg seq ms | seq speedup | native ${report.concurrency}x ms | rg ${report.concurrency}x ms | ${report.concurrency}x speedup | native matches | rg matches |`,
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const entry of report.cases) {
		const seq = entry.rg.sequentialMinMs / entry.native.sequentialMinMs;
		const concurrent = entry.rg.concurrentMinMs / entry.native.concurrentMinMs;
		lines.push(
			`| ${entry.name} | ${entry.native.sequentialMinMs.toFixed(2)} | ${entry.rg.sequentialMinMs.toFixed(2)} | ${seq.toFixed(2)}x | ${entry.native.concurrentMinMs.toFixed(2)} | ${entry.rg.concurrentMinMs.toFixed(2)} | ${concurrent.toFixed(2)}x | ${entry.native.matches} | ${entry.rg.matches} |`,
		);
	}
	lines.push("");
	lines.push(`platform-arch: ${report.platform}`);
	lines.push(
		`load average: ${report.loadAverage.map((value) => value.toFixed(2)).join(" ")} (${report.cores} cores)`,
	);
	lines.push("");
	return `${lines.join("\n")}`;
}

async function runBench(repoRoot = repoRootFromScript()) {
	const addonPath = resolveNativeAddon(repoRoot);
	const native = createRequire(import.meta.url)(addonPath);
	const cwd = resolve(repoRoot);
	const prepared = benchCases(repoRoot).map((spec) => {
		const searchPath = isAbsolute(spec.path) ? spec.path : resolve(repoRoot, spec.path);
		const request = {
			pattern: spec.pattern,
			searchPath,
			cwd,
			glob: spec.glob,
			literal: spec.literal,
			maxCount: spec.maxCount,
		};
		return {
			spec,
			nativeOnce: () => runNative(native, request),
			rgOnce: () => runRg(request),
			// Timed rg runs the same argv and JSON parse as grep.ts, including
			// kill-at-cap for the match-count warmup. Throughput uses a full
			// subprocess (no cap) so the ordered engine's early stop is compared
			// against the planner's ~30ms rg, not time-to-100-matches.
			rgTimed: () => runRg({ ...request, maxCount: undefined }),
		};
	});
	const cases = [];
	for (const entry of prepared) {
		const nativeWarm = await entry.nativeOnce();
		const rgWarm = await entry.rgOnce();
		const nativeSeq = await minOf(ITERATIONS, entry.nativeOnce);
		const rgSeq = await minOf(ITERATIONS, entry.rgTimed);
		cases.push({
			id: entry.spec.id,
			name: entry.spec.name,
			mode: "content",
			maxCount: entry.spec.maxCount,
			native: {
				sequentialMinMs: nativeSeq.minMs,
				concurrentMinMs: 0,
				matches: nativeWarm.matches,
			},
			rg: {
				sequentialMinMs: rgSeq.minMs,
				concurrentMinMs: 0,
				matches: rgWarm.matches,
			},
		});
	}
	for (const [index, entry] of prepared.entries()) {
		const nativeConc = await minOfConcurrent(ITERATIONS, CONCURRENCY, entry.nativeOnce);
		const rgConc = await minOfConcurrent(ITERATIONS, CONCURRENCY, entry.rgTimed);
		cases[index].native.concurrentMinMs = nativeConc.minMs;
		cases[index].rg.concurrentMinMs = rgConc.minMs;
	}
	return {
		platform: `${process.platform}-${process.arch}`,
		cores: cpus().length,
		loadAverage: [...loadavg()],
		iterations: ITERATIONS,
		concurrency: CONCURRENCY,
		bun: commandVersion("bun"),
		rustc: commandVersion("rustc"),
		rg: commandVersion("rg"),
		cases,
	};
}

async function main(argv = process.argv.slice(2)) {
	const { values } = parseArgs({
		args: argv,
		options: {
			json: { type: "string" },
			gate: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (values.gate) {
		const report = JSON.parse(readFileSync(values.gate, "utf8"));
		const result = evaluateGrepBenchGate(report);
		if (!result.ok) {
			for (const failure of result.failures) {
				process.stderr.write(`gate: FAIL ${failure}\n`);
			}
			process.exitCode = 1;
			return;
		}
		process.stdout.write("gate: PASS\n");
		return;
	}
	const report = await runBench();
	process.stdout.write(renderMarkdownTable(report));
	if (values.json) {
		const jsonPath = values.json;
		mkdirSync(dirname(resolve(jsonPath)), { recursive: true });
		writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	}
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	await main();
}
