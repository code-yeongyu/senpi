import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectors } from "../../scenarios/fused-equivalence/cases/support/collectors.mjs";
import { readWitness } from "../../scenarios/fused-equivalence/cases/support/witness.mjs";

test("pipeline receipts are read from entries without changing O7 or its parent chain", () => {
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
		assert.deepEqual(readWitness(sessionFile), {
			pipeline: "legacy", source: "entries",
			calls: [{ toolCallId: "one", pipeline: "legacy" }, { toolCallId: "two", pipeline: "legacy" }],
		});
		assert.deepEqual(collectors.O7(run), baseline);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
