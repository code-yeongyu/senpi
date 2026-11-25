#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export function balanceShards(files, durations, count) {
	const known = files
		.filter((file) => durations.has(file))
		.map((file) => durations.get(file))
		.sort((a, b) => a - b);
	if (known.length === 0) return null;

	const median = (known[Math.floor((known.length - 1) / 2)] + known[Math.floor(known.length / 2)]) / 2;
	const ranked = files
		.map((file) => ({ file, cost: Math.max(1, durations.get(file) ?? median) }))
		.sort((a, b) => b.cost - a.cost || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	const shards = Array.from({ length: count }, () => ({ cost: 0, files: [] }));
	for (const { file, cost } of ranked) {
		const lightest = shards.reduce((best, shard) => (shard.cost < best.cost ? shard : best));
		lightest.files.push(file);
		lightest.cost += cost;
	}
	return shards.map((shard) => shard.files);
}

export function verifyCoverage(expected, shardFiles) {
	const expectedFiles = new Set(expected);
	const remaining = new Set(expectedFiles);
	const seen = new Set();
	const duplicate = new Set();
	const unexpected = new Set();
	for (const files of shardFiles) {
		for (const file of files) {
			if (seen.has(file)) duplicate.add(file);
			if (!expectedFiles.has(file)) unexpected.add(file);
			remaining.delete(file);
			seen.add(file);
		}
	}
	const problems = [
		["Missing", remaining],
		["Duplicate", duplicate],
		["Unexpected", unexpected],
	]
		.filter(([, files]) => files.size > 0)
		.map(([label, files]) => `${label} (${files.size}): ${[...files].sort().join(", ")}`);
	if (problems.length > 0) throw new Error(`Coding-agent shard coverage failed:\n${problems.join("\n")}`);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));

function readTimings(path) {
	const rows = readJson(path);
	if (
		!Array.isArray(rows) ||
		!rows.every(
			(row) =>
				Array.isArray(row) &&
				row.length === 2 &&
				typeof row[0] === "string" &&
				row[0] !== "" &&
				Number.isFinite(row[1]) &&
				row[1] >= 0,
		)
	) {
		throw new TypeError("Invalid coding-agent file timing record");
	}
	return rows;
}

function restoreTimings(path) {
	try {
		return new Map(readTimings(path));
	} catch (error) {
		if (error.code === "ENOENT") return new Map();
		if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
		console.warn(`Ignoring unusable coding-agent timing cache: ${error.message}`);
		return new Map();
	}
}

function plan(discoveryPath, timingsPath, planPath, count) {
	const files = readJson(discoveryPath)
		.map(({ file }) => relative(process.cwd(), file))
		.sort();
	if (!Number.isInteger(count) || count < 1 || files.length < count || new Set(files).size !== files.length) {
		throw new Error(`Cannot plan ${count} shards from ${files.length} discovered files (too few or duplicate files)`);
	}
	const durations = restoreTimings(timingsPath);
	const shards = balanceShards(files, durations, count);
	console.log(
		`Coding-agent shard mode: ${shards ? "duration-balanced" : "Vitest hash (no matching timings)"}; ${files.length} files, ${count} shards`,
	);
	writeJson(planPath, { files, count, shards });
}

function verify(planPath, reportsDir, timingsPath) {
	const { files, count } = readJson(planPath);
	const reports = Array.from({ length: count }, (_, index) =>
		readTimings(join(reportsDir, `report-${index + 1}.json`)),
	);
	verifyCoverage(
		files,
		reports.map((report) => report.map(([file]) => file)),
	);
	writeJson(
		timingsPath,
		reports.flat().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
	console.log(`Verified: all ${files.length} coding-agent test files finished exactly once across ${count} shards`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, ...args] = process.argv.slice(2);
	if (command === "plan" && args.length === 4) plan(args[0], args[1], args[2], Number(args[3]));
	else if (command === "verify" && args.length === 3) verify(...args);
	else {
		throw new Error(
			"usage: ci-coding-agent-shards.mjs plan <discovery> <timings> <plan> <count> | verify <plan> <reports-dir> <timings>",
		);
	}
}
