#!/usr/bin/env node
// Workflow steps of native-prebuilds.yml that decide which targets to reuse (senpi#6622).
// Inputs arrive through env, never through the step's shell text.
//
//   keys                       RUSTC_VV                   -> outputs keys, rustc
//   select  --cache-root <d>   KEYS, MATCHED_KEYS, RUSTC  -> outputs reused, matrix, missing, missing_count
//   record  --artifact-dir <d> TARGET_ARTIFACT, KEY, RUSTC_VV
//   collect --download-root <d> --cache-root <d>  KEYS, RUSTC, MISSING -> outputs save

import { appendFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { computeKey, loadTargets, normalizeRustc } from "./native-prebuild-key.mjs";
import { verifyRecord, writeRecord } from "./native-prebuild-record.mjs";

const repoRoot = join(import.meta.dirname, "..");

function output(name, value) {
	const line = `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`;
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
	process.stdout.write(line);
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function targetByArtifact(targets, artifact) {
	const target = targets.find((row) => row.artifact === artifact);
	if (!target) throw new Error(`unknown native prebuild artifact ${artifact}`);
	return target;
}

function keys() {
	const rustc = normalizeRustc(requireEnv("RUSTC_VV"));
	const map = Object.fromEntries(loadTargets(repoRoot).map((target) => [target.artifact, computeKey({ repoRoot, target, rustc })]));
	output("rustc", rustc);
	output("keys", map);
}

// A restored cache directory is reused only when its record verifies; anything else is built.
function select(cacheRoot) {
	const map = JSON.parse(requireEnv("KEYS"));
	const matched = JSON.parse(requireEnv("MATCHED_KEYS"));
	const rustc = requireEnv("RUSTC");
	const reused = [];
	const include = [];
	for (const target of loadTargets(repoRoot)) {
		const key = map[target.artifact];
		if (!key) throw new Error(`KEYS has no key for ${target.artifact}`);
		const dir = join(cacheRoot, target.artifact);
		const verdict = !existsSync(dir)
			? { ok: false, reason: "no cache entry" }
			: matched[target.artifact] !== key
				? { ok: false, reason: `restored entry ${matched[target.artifact] || "(none)"} is not the exact key` }
				: verifyRecord({ artifactDir: dir, target, key, rustc });
		console.error(`${target.artifact}: ${verdict.ok ? "REUSE" : `BUILD (${verdict.reason})`}`);
		if (verdict.ok) reused.push(target.artifact);
		else include.push({ ...target, key });
	}
	output("reused", reused);
	output("matrix", { include });
	output("missing", include.map((target) => target.artifact));
	output("missing_count", String(include.length));
}

function record(artifactDir) {
	const target = targetByArtifact(loadTargets(repoRoot), requireEnv("TARGET_ARTIFACT"));
	const written = writeRecord({ artifactDir, target, key: requireEnv("KEY"), rustc: normalizeRustc(requireEnv("RUSTC_VV")) });
	console.log(JSON.stringify(written, null, "\t"));
}

// Copies each freshly built artifact whose record matches the planned key and rustc into the
// cache root; a builder that resolved another rustc than the plan is not saved under that key.
function collect(downloadRoot, cacheRoot) {
	const targets = loadTargets(repoRoot);
	const map = JSON.parse(requireEnv("KEYS"));
	const rustc = requireEnv("RUSTC");
	const save = [];
	for (const artifact of JSON.parse(requireEnv("MISSING"))) {
		const target = targetByArtifact(targets, artifact);
		const dir = join(downloadRoot, artifact);
		const verdict = existsSync(dir) ? verifyRecord({ artifactDir: dir, target, key: map[artifact], rustc }) : { ok: false, reason: "not built in this run" };
		console.error(`${artifact}: ${verdict.ok ? "SAVE" : `SKIP (${verdict.reason})`}`);
		if (!verdict.ok) continue;
		rmSync(join(cacheRoot, artifact), { recursive: true, force: true });
		cpSync(dir, join(cacheRoot, artifact), { recursive: true });
		save.push(artifact);
	}
	output("save", save);
}

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { "cache-root": { type: "string" }, "artifact-dir": { type: "string" }, "download-root": { type: "string" } },
});
const command = positionals[0];
const option = (name) => {
	if (!values[name]) throw new Error(`${command} requires --${name}`);
	return values[name];
};
if (command === "keys") keys();
else if (command === "select") select(option("cache-root"));
else if (command === "record") record(option("artifact-dir"));
else if (command === "collect") collect(option("download-root"), option("cache-root"));
else throw new Error(`usage: native-prebuild-reuse.mjs keys|select|record|collect (got ${command})`);
