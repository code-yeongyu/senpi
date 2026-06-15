#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BENCHES = {
	"ai-event-stream": "packages/ai/bench/event-stream.ts",
	"ai-model-registry": "packages/ai/bench/model-registry.ts",
	"tui-editor": "packages/tui/bench/editor-layout.ts",
	"tui-markdown": "packages/tui/bench/markdown-render.ts",
	"coding-agent-render-transcript": "packages/coding-agent/bench/render-transcript.ts",
	"coding-agent-bash-output": "packages/coding-agent/bench/bash-output.ts",
	"coding-agent-jsonl-parse": "packages/coding-agent/bench/jsonl-parse.ts",
	"coding-agent-rpc-event-emit": "packages/coding-agent/bench/rpc-event-emit.ts",
	"compaction-trim": "packages/coding-agent/bench/compaction-trim.ts",
	"word-diff": "packages/coding-agent/bench/word-diff.ts",
};

function parseArgs(argv) {
	const args = {
		suite: "all",
		iterations: "20",
		json: undefined,
		baseline: undefined,
		expectMedianImprovement: 0,
		expectP95Improvement: 0,
		allowRegressionPct: 0,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const readValue = () => {
			const value = argv[i + 1];
			if (!value) throw new Error(`Missing value for ${arg}`);
			i++;
			return value;
		};
		if (arg === "--suite") args.suite = readValue();
		else if (arg === "--iterations") args.iterations = readValue();
		else if (arg === "--json") args.json = readValue();
		else if (arg === "--baseline") args.baseline = readValue();
		else if (arg === "--expect-median-improvement") args.expectMedianImprovement = Number(readValue());
		else if (arg === "--expect-p95-improvement") args.expectP95Improvement = Number(readValue());
		else if (arg === "--allow-regression-pct") args.allowRegressionPct = Number(readValue());
		else if (arg.includes("=")) {
			const [key, value] = arg.split("=", 2);
			if (key === "--suite") args.suite = value;
			else if (key === "--iterations") args.iterations = value;
			else if (key === "--json") args.json = value;
			else if (key === "--baseline") args.baseline = value;
			else if (key === "--expect-median-improvement") args.expectMedianImprovement = Number(value);
			else if (key === "--expect-p95-improvement") args.expectP95Improvement = Number(value);
			else if (key === "--allow-regression-pct") args.allowRegressionPct = Number(value);
			else throw new Error(`Unknown argument: ${arg}`);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function selectedBenches(suite) {
	if (suite === "all") return Object.entries(BENCHES);
	const names = suite.split(",").map((name) => name.trim()).filter(Boolean);
	return names.map((name) => {
		const path = BENCHES[name];
		if (!path) throw new Error(`Unknown suite: ${name}`);
		return [name, path];
	});
}

function runBench(name, path, iterations) {
	const result = spawnSync(
		process.execPath,
		["--expose-gc", "--import", "tsx", path, "--iterations", iterations],
		{ cwd: process.cwd(), encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error(`Benchmark ${name} failed\n${result.stdout}\n${result.stderr}`);
	}
	const stdout = result.stdout.trim();
	const line = stdout.split("\n").at(-1);
	if (!line) throw new Error(`Benchmark ${name} produced no JSON`);
	const parsed = JSON.parse(line);
	if (parsed.suite !== name) throw new Error(`Benchmark ${name} returned suite ${parsed.suite}`);
	if (result.stderr.trim()) process.stderr.write(result.stderr);
	return parsed;
}

function bySuite(results) {
	return new Map(results.map((result) => [result.suite, result]));
}

function percentImprovement(before, after) {
	if (!Number.isFinite(before) || before <= 0) return 0;
	return ((before - after) / before) * 100;
}

function compareWithBaseline(current, baseline, args) {
	const baselineBySuite = bySuite(baseline.results);
	const failures = [];
	const comparisons = [];
	for (const result of current.results) {
		const base = baselineBySuite.get(result.suite);
		if (!base) {
			failures.push(`Missing baseline for ${result.suite}`);
			continue;
		}
		const medianImprovement = percentImprovement(base.medianMs, result.medianMs);
		const p95Improvement = percentImprovement(base.p95Ms, result.p95Ms);
		comparisons.push({
			suite: result.suite,
			baselineMedianMs: base.medianMs,
			currentMedianMs: result.medianMs,
			medianImprovementPct: medianImprovement,
			baselineP95Ms: base.p95Ms,
			currentP95Ms: result.p95Ms,
			p95ImprovementPct: p95Improvement,
		});
		if (medianImprovement < args.expectMedianImprovement) {
			failures.push(
				`${result.suite} median improvement ${medianImprovement.toFixed(2)}% < ${args.expectMedianImprovement}%`,
			);
		}
		if (args.expectP95Improvement > 0 && p95Improvement < args.expectP95Improvement) {
			failures.push(`${result.suite} p95 improvement ${p95Improvement.toFixed(2)}% < ${args.expectP95Improvement}%`);
		}
		if (medianImprovement < -args.allowRegressionPct) {
			failures.push(`${result.suite} median regression ${(-medianImprovement).toFixed(2)}%`);
		}
	}
	current.comparisons = comparisons;
	current.comparisonFailures = failures;
	if (failures.length > 0) {
		throw new Error(failures.join("\n"));
	}
}

const args = parseArgs(process.argv.slice(2));
const start = performance.now();
const results = selectedBenches(args.suite).map(([name, path]) => runBench(name, path, args.iterations));
const payload = {
	schemaVersion: 1,
	createdAt: new Date().toISOString(),
	gitCommit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
	iterations: Number(args.iterations),
	durationMs: performance.now() - start,
	results,
};

if (args.baseline) {
	const baseline = JSON.parse(readFileSync(args.baseline, "utf8"));
	compareWithBaseline(payload, baseline, args);
}

const json = `${JSON.stringify(payload, null, 2)}\n`;
if (args.json) {
	const outputPath = resolve(args.json);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, json);
} else {
	process.stdout.write(json);
}
