import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectors } from "../../scenarios/fused-equivalence/cases/support/collectors.mjs";
import { readWitness, toolCallCount, witnessMatches } from "../../scenarios/fused-equivalence/cases/support/witness.mjs";

test("older execution-pipeline entries never change O7 or its parent chain", () => {
	const dir = mkdtempSync(join(tmpdir(), "execution-witness-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		const original = [
			{ type: "session", id: "s" },
			{ type: "message", id: "a", parentId: null, message: { role: "assistant" } },
			{ type: "message", id: "b", parentId: "a", message: { role: "toolResult" } },
			{ type: "custom", id: "c", parentId: "b", customType: "other", data: { keep: true } },
		];
		writeFileSync(sessionFile, original.map((entry) => JSON.stringify(entry)).join("\n"));
		const run = { sessionFile, sessionIds: ["s"] };
		const baseline = collectors.O7(run);
		const witnessed = [
			...original.slice(0, 2),
			{ type: "custom", id: "w1", parentId: "a", customType: "execution-pipeline", data: { pipeline: "legacy", toolCallId: "one" } },
			{ type: "custom", id: "w2", parentId: "w1", customType: "execution-pipeline", data: { pipeline: "legacy", toolCallId: "two" } },
			{ ...original[2], parentId: "w2" },
			original[3],
		];
		writeFileSync(sessionFile, witnessed.map((entry) => JSON.stringify(entry)).join("\n"));
		assert.deepEqual(collectors.O7(run), baseline);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the witness is read from the session's sink file, one JSON line per call", () => {
	const dir = mkdtempSync(join(tmpdir(), "execution-witness-"));
	try {
		const witnessFile = join(dir, "witness.jsonl");
		assert.deepEqual(readWitness(witnessFile), { pipeline: "legacy", source: "no-seam", calls: [] });
		writeFileSync(witnessFile, '{"pipeline":"prepared","toolCallId":"one"}\n{"pipeline":"prepared","toolCallId":"two"}\n');
		assert.deepEqual(readWitness(witnessFile), {
			pipeline: "prepared",
			source: "sink",
			calls: [{ toolCallId: "one", pipeline: "prepared" }, { toolCallId: "two", pipeline: "prepared" }],
		});
		writeFileSync(witnessFile, '{"pipeline":"prepared","toolCallId":"one"}\n{"pipeline":"legacy","toolCallId":"two"}\n');
		assert.equal(readWitness(witnessFile).pipeline, "mixed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run with tool calls must have its witness from the sink, whatever the pipeline", () => {
	const noSeam = { pipeline: "legacy", source: "no-seam", calls: [] };
	assert.equal(witnessMatches({ ...noSeam, toolCalls: 2 }, "legacy"), false);
	assert.equal(witnessMatches({ ...noSeam, toolCalls: 2 }, "default"), false);
	assert.equal(witnessMatches({ ...noSeam, toolCalls: 0 }, "default"), true);
	assert.equal(witnessMatches({ pipeline: "legacy", source: "sink", calls: [{}], toolCalls: 1 }, "legacy"), true);
	assert.equal(witnessMatches({ pipeline: "legacy", source: "sink", calls: [{}], toolCalls: 1 }, "prepared"), false);
	const dir = mkdtempSync(join(tmpdir(), "execution-witness-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(sessionFile, [{ type: "message", message: { role: "assistant" } }, { type: "message", message: { role: "toolResult" } }, { type: "message", message: { role: "toolResult" } }].map((entry) => JSON.stringify(entry)).join("\n"));
		assert.equal(toolCallCount(sessionFile), 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
