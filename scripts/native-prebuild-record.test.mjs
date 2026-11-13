import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_RECORD_AGE_DAYS, recordFileName, verifyRecord, writeRecord } from "./native-prebuild-record.mjs";

const target = { artifact: "native-prebuild-darwin-arm64", node_platform: "darwin", node_arch: "arm64", cross_compile: false };
const crossTarget = { artifact: "native-prebuild-darwin-x64", node_platform: "darwin", node_arch: "x64", cross_compile: true };
const key = `native-prebuild-v1-native-prebuild-darwin-arm64-${"a".repeat(64)}`;
const rustc = "release: 1.91.0 commit-hash: f8297e351a40c1439a467bbbb6879088047f50b3";
const builtAt = new Date("2026-11-13T00:00:00Z");
const now = new Date("2026-11-14T00:00:00Z");

const roots = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The layout the Stage artifact step uploads.
function stagedArtifact(row = target) {
	const dir = mkdtempSync(join(tmpdir(), "native-prebuild-record-"));
	roots.push(dir);
	const host = `${row.node_platform}-${row.node_arch}`;
	mkdirSync(join(dir, "native/prebuilds", host), { recursive: true });
	writeFileSync(join(dir, "native/prebuilds", host, `senpi_pty.${host}.node`), `pty ${host}\n`);
	writeFileSync(join(dir, `senpi_grep.${host}.node`), `grep ${host}\n`);
	writeFileSync(join(dir, "manifest.txt"), `artifact=${row.artifact}\n`);
	writeRecord({ artifactDir: dir, target: row, key, rustc, builtAt });
	return dir;
}

const expected = { target, key, rustc, now };

describe("native prebuild record", () => {
	it("records the sha256 of every staged file and verifies the same bytes", () => {
		const dir = stagedArtifact();
		const record = JSON.parse(readFileSync(join(dir, recordFileName(target)), "utf8"));
		assert.equal(recordFileName(target), "native-prebuild-record-darwin-arm64.json");
		assert.deepEqual(Object.keys(record.files), ["manifest.txt", "native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node", "senpi_grep.darwin-arm64.node"]);
		for (const digest of Object.values(record.files)) assert.match(digest, /^[0-9a-f]{64}$/);
		assert.equal(record.lifecycle_tests, "passed");
		assert.deepEqual(verifyRecord({ artifactDir: dir, ...expected }), { ok: true });
	});

	it("marks cross-compiled rows as having no on-runner lifecycle tests, and requires that marking", () => {
		const dir = stagedArtifact(crossTarget);
		assert.equal(JSON.parse(readFileSync(join(dir, recordFileName(crossTarget)), "utf8")).lifecycle_tests, "not-run-cross-compile");
		assert.deepEqual(verifyRecord({ artifactDir: dir, ...expected, target: crossTarget }), { ok: true });
		const native = stagedArtifact();
		const record = JSON.parse(readFileSync(join(native, recordFileName(target)), "utf8"));
		writeFileSync(join(native, recordFileName(target)), JSON.stringify({ ...record, lifecycle_tests: "not-run-cross-compile" }));
		assert.match(verifyRecord({ artifactDir: native, ...expected }).reason, /lifecycle/);
	});

	it("rejects changed, missing and extra files", () => {
		const changed = stagedArtifact();
		writeFileSync(join(changed, "senpi_grep.darwin-arm64.node"), "tampered\n");
		assert.match(verifyRecord({ artifactDir: changed, ...expected }).reason, /sha256 mismatch: senpi_grep\.darwin-arm64\.node/);

		const missing = stagedArtifact();
		unlinkSync(join(missing, "manifest.txt"));
		assert.match(verifyRecord({ artifactDir: missing, ...expected }).reason, /file set/);

		const extra = stagedArtifact();
		writeFileSync(join(extra, "extra.node"), "x\n");
		assert.match(verifyRecord({ artifactDir: extra, ...expected }).reason, /file set/);
	});

	it("rejects a record for another key, artifact or rustc", () => {
		const dir = stagedArtifact();
		assert.match(verifyRecord({ artifactDir: dir, ...expected, key: `${key.slice(0, -1)}b` }).reason, /key/);
		assert.match(verifyRecord({ artifactDir: dir, ...expected, target: { ...target, artifact: "native-prebuild-darwin-x64", node_arch: "x64" } }).reason, /record|artifact/);
		assert.match(verifyRecord({ artifactDir: dir, ...expected, rustc: rustc.replace("1.91.0", "1.91.1") }).reason, /rustc/);
	});

	it("rejects a missing or unreadable record and one older than the age limit", () => {
		const none = mkdtempSync(join(tmpdir(), "native-prebuild-record-none-"));
		roots.push(none);
		assert.match(verifyRecord({ artifactDir: none, ...expected }).reason, /record/);

		const garbled = stagedArtifact();
		writeFileSync(join(garbled, recordFileName(target)), "{not json");
		assert.match(verifyRecord({ artifactDir: garbled, ...expected }).reason, /record/);

		const dir = stagedArtifact();
		const tooLate = new Date(builtAt.getTime() + (MAX_RECORD_AGE_DAYS + 1) * 86_400_000);
		assert.match(verifyRecord({ artifactDir: dir, ...expected, now: tooLate }).reason, /older than/);
	});
});
