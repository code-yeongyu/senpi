import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRunRecord } from "../../scenarios/live-session/fixture/support/run-record.mjs";
import { writeEvidence } from "../../scenarios/live-session/fixture/support/report.mjs";
import { repoRoot } from "./common.mjs";

// senpi#5128: exercise the actual hook process and evidence writer, not a second implementation.
test("raw hook provenance and every sandbox session survive evidence export and cleanup", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "live-evidence-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const work = join(dir, "work");
	mkdirSync(work);
	const hookTrace = join(dir, "hook-trace.jsonl");
	const input = { hook_event_name: "PreToolUse", tool_use_id: "child-call", tool_name: "read", session_id: "child" };
	const hook = spawnSync(process.execPath, [
		join(repoRoot(), ".agents/skills/senpi-qa/scenarios/live-session/fixture/hooks/hook.mjs"), hookTrace,
	], { input: JSON.stringify(input), encoding: "utf8" });
	assert.equal(hook.status, 0, hook.stderr);
	const raw = readFileSync(hookTrace, "utf8");
	const row = JSON.parse(raw);
	assert.equal(row.session_id, "child");
	assert.equal(row.pid, hook.pid);
	assert.ok(Number.isFinite(Date.parse(row.timestamp)));
	const entries = [{ type: "session", id: "parent" }];
	const children = ["child", "grandchild"].map((id) => [
		{ type: "session", id },
		{ type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: `${id}-call`, name: "read", arguments: {} },
		] } },
	]);
	for (const [index, transcript] of children.entries()) {
		const childDir = join(dir, "work", ".omo", "children", `${index}`, "sessions");
		mkdirSync(childDir, { recursive: true });
		writeFileSync(join(childDir, "session.jsonl"), transcript.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	}
	// JSONL files that are not session transcripts must not be exported as sessions.
	writeFileSync(join(dir, "unrelated.jsonl"), '{"type":"usage"}\n');
	const session = { entries, events: [] };
	const record = buildRunRecord({
		setup: { box: { dir, cwd: work }, hookTrace },
		session,
		proxy: { records: [] },
		placement: "fused",
	});
	assert.equal(record.sessionTranscripts.length, 2);
	assert.deepEqual(record.hookTrace, [row]);
	const out = writeEvidence(`live-evidence-${process.pid}`, { kind: "test" }, session);
	t.after(() => rmSync(out, { recursive: true, force: true }));
	rmSync(dir, { recursive: true, force: true });
	assert.equal(readFileSync(join(out, "hook-trace.jsonl"), "utf8"), raw);
	const manifest = JSON.parse(readFileSync(join(out, "sessions.json"), "utf8"));
	assert.deepEqual(readdirSync(out, { withFileTypes: true }).filter((entry) => entry.isDirectory()), []);
	assert.deepEqual(manifest.sessions.map((entry) => entry.session_id).sort(), ["child", "grandchild"]);
	for (const entry of manifest.sessions) {
		const saved = readFileSync(join(out, entry.file), "utf8").trim().split("\n").map(JSON.parse);
		assert.deepEqual(saved, children.find((transcript) => transcript[0].id === entry.session_id));
	}
});

test("malformed sandbox JSONL headers are skipped visibly without losing valid sessions", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "live-headers-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, text] of Object.entries({
		"broken.jsonl": "{broken\n",
		"foreign.jsonl": "not JSON\n",
		"usage.jsonl": '{"type":"usage"}\n',
		"child.jsonl": '{"type":"session","id":"child"}\n',
	})) writeFileSync(join(dir, name), text);
	const session = { entries: [{ type: "session", id: "parent" }], events: [] };
	const record = buildRunRecord({
		setup: { box: { dir, cwd: dir }, hookTrace: join(dir, "hooks.jsonl") },
		session, proxy: { records: [] }, placement: "fused",
	});
	assert.deepEqual(record.sessionTranscripts.map((transcript) => transcript.entries[0].id), ["child"]);
	const out = writeEvidence(`live-headers-${process.pid}`, { kind: "test" }, session);
	t.after(() => rmSync(out, { recursive: true, force: true }));
	const manifest = JSON.parse(readFileSync(join(out, "sessions.json"), "utf8"));
	assert.deepEqual(manifest.skippedPaths.sort(), ["broken.jsonl", "foreign.jsonl"]);
	assert.deepEqual(manifest.sessions.map((entry) => entry.session_id), ["child"]);
	assert.deepEqual(readdirSync(out, { withFileTypes: true }).filter((entry) => entry.isDirectory()), []);
});
