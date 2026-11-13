#!/usr/bin/env node
// Record of one built native prebuild (senpi#6622): the sha256 of every file the build job
// uploaded, the reuse key and rustc it was built for, and whether its lifecycle tests ran.
// A reuse is accepted only when the bytes still match this record.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const RECORD_SCHEMA = 1;
// Bounds how far a reused prebuild can trail the hosted runner images and SDKs, which the key
// cannot see; an older record is a miss and the target is rebuilt.
export const MAX_RECORD_AGE_DAYS = 14;

export function recordFileName(target) {
	return `native-prebuild-record-${target.node_platform}-${target.node_arch}.json`;
}

// Cross-compiled rows cannot load their addon on the runner, so the build job skips the Rust
// lifecycle tests and the Node probe for them (native-prebuilds.yml).
function expectedLifecycle(target) {
	return target.cross_compile ? "not-run-cross-compile" : "passed";
}

function listFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) files.push(relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
	}
	return files.sort();
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestFiles(artifactDir, recordName) {
	const files = {};
	for (const path of listFiles(artifactDir)) {
		if (path !== recordName) files[path] = sha256(join(artifactDir, path));
	}
	return files;
}

// Runs in the build job after the lifecycle tests and the probe passed, before the upload.
export function writeRecord({ artifactDir, target, key, rustc, builtAt = new Date() }) {
	const name = recordFileName(target);
	const record = {
		schema: RECORD_SCHEMA,
		artifact: target.artifact,
		key,
		rustc,
		lifecycle_tests: expectedLifecycle(target),
		built_at: builtAt.toISOString(),
		files: digestFiles(artifactDir, name),
	};
	writeFileSync(join(artifactDir, name), `${JSON.stringify(record, null, "\t")}\n`);
	return record;
}

function readRecord(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function verifyRecord({ artifactDir, target, key, rustc, now = new Date() }) {
	const name = recordFileName(target);
	const record = readRecord(join(artifactDir, name));
	if (record.error) return { ok: false, reason: `no readable record ${name}: ${record.error}` };
	if (record.schema !== RECORD_SCHEMA) return { ok: false, reason: `record schema ${record.schema}, expected ${RECORD_SCHEMA}` };
	if (record.artifact !== target.artifact) return { ok: false, reason: `record artifact ${record.artifact}, expected ${target.artifact}` };
	if (record.key !== key) return { ok: false, reason: `record key ${record.key}, expected ${key}` };
	if (record.rustc !== rustc) return { ok: false, reason: `record rustc ${record.rustc}, expected ${rustc}` };
	if (record.lifecycle_tests !== expectedLifecycle(target)) {
		return { ok: false, reason: `record lifecycle_tests ${record.lifecycle_tests}, expected ${expectedLifecycle(target)}` };
	}
	const builtAt = Date.parse(record.built_at);
	if (!Number.isFinite(builtAt)) return { ok: false, reason: `record built_at ${record.built_at} is not a date` };
	if (now.getTime() - builtAt > MAX_RECORD_AGE_DAYS * 86_400_000) {
		return { ok: false, reason: `record built ${record.built_at} is older than ${MAX_RECORD_AGE_DAYS} days` };
	}
	const recorded = Object.keys(record.files ?? {}).sort();
	const present = listFiles(artifactDir).filter((path) => path !== name);
	if (JSON.stringify(recorded) !== JSON.stringify(present)) {
		return { ok: false, reason: `file set differs from the record: recorded ${JSON.stringify(recorded)}, present ${JSON.stringify(present)}` };
	}
	for (const path of recorded) {
		if (sha256(join(artifactDir, path)) !== record.files[path]) return { ok: false, reason: `sha256 mismatch: ${path}` };
	}
	return { ok: true };
}
