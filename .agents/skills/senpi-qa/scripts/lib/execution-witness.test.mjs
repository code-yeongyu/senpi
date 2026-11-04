import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectors } from "../../scenarios/fused-equivalence/cases/support/collectors.mjs";
import { readWitness, witnessOk } from "../../scenarios/fused-equivalence/cases/support/witness.mjs";
import { classifyMutation } from "./equivalence-mutations.mjs";

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

// senpi#5728 (S36): one pipeline, so a run whose tools ran with no receipt is "missing" and fails; no tool call passes.
test("the witness is read from the session's sink file: missing, no-calls, prepared, mixed", () => {
	const dir = mkdtempSync(join(tmpdir(), "execution-witness-"));
	try {
		const witnessFile = join(dir, "witness.jsonl");
		const sessionFile = join(dir, "session.jsonl");
		const assistant = (content) => JSON.stringify({ type: "message", id: "a", message: { role: "assistant", content } });
		writeFileSync(sessionFile, assistant([{ type: "text", text: "hi" }]));
		assert.deepEqual(readWitness(witnessFile, [sessionFile]), { pipeline: "no-calls", source: "none", calls: [] });
		writeFileSync(sessionFile, assistant([{ type: "toolCall", id: "one" }]));
		const missing = readWitness(witnessFile, [undefined, sessionFile]);
		assert.deepEqual(missing, { pipeline: "missing", source: "none", calls: [] });
		writeFileSync(witnessFile, '{"pipeline":"prepared","toolCallId":"one"}\n{"pipeline":"prepared","toolCallId":"two"}\n');
		const prepared = readWitness(witnessFile, [sessionFile]);
		assert.deepEqual(prepared, {
			pipeline: "prepared",
			source: "sink",
			calls: [{ toolCallId: "one", pipeline: "prepared" }, { toolCallId: "two", pipeline: "prepared" }],
		});
		writeFileSync(witnessFile, '{"pipeline":"prepared","toolCallId":"one"}\n{"pipeline":"other","toolCallId":"two"}\n');
		const mixed = readWitness(witnessFile, [sessionFile]);
		assert.equal(mixed.pipeline, "mixed");
		assert.deepEqual(
			[missing, { pipeline: "no-calls" }, prepared, mixed].map(witnessOk),
			[false, true, true, false],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a mutation that only breaks the witness is KILLED by its witness row", () => {
	const mutation = { expect: { E01: /^witness\.pipeline: actual="missing"$/ } };
	const verdict = classifyMutation(mutation, {
		runnable: ["E01"],
		baseline: new Map([["E01", "PASS"]]),
		run: { exitCode: 1, results: [{ id: "E01", pass: false, diffs: [], witnessOk: false, witness: { pipeline: "missing" } }] },
		revert: { clean: true, reapplies: true },
	});
	assert.equal(verdict.status, "KILLED");
});
