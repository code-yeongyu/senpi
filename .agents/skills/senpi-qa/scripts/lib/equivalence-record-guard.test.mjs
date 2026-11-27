import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { goldenLeaks, recordHostProblems } from "./equivalence-record-guard.mjs";

const golden = (systemPrompt) =>
	`${JSON.stringify({ id: "E08", observations: { O1: [{ body: { messages: [{ content: systemPrompt }] } }] } }, null, 1)}\n`;

test("a golden whose recorded prompt carries the recording host's project rules is refused", () => {
	const leaks = goldenLeaks(golden("You are senpi.\n<project_rules>\n# from ~/AGENTS.md\n</project_rules>"));
	assert.deepEqual(
		leaks.map((leak) => leak.marker),
		["<project_rules>", "AGENTS.md"],
	);
});

test("a golden naming a real home path is refused", () => {
	for (const path of ["/Users/someone/work", "/home/someone/work", "C:\\Users\\someone\\work"]) {
		assert.equal(goldenLeaks(golden(`cwd: ${path}`)).length, 1, path);
	}
});

test("a golden made of sandbox placeholders only is accepted", () => {
	assert.deepEqual(goldenLeaks(golden("You are senpi.\ncwd: <sandbox>/work")), []);
});

test("a record host whose temp dir sits below a project-rules file is refused before any case runs", () => {
	const root = mkdtempSync(join(tmpdir(), "eq-record-guard-"));
	try {
		const temp = join(root, "runs", "tmp");
		mkdirSync(temp, { recursive: true });
		assert.deepEqual(recordHostProblems({ temp, home: join(root, "elsewhere") }), []);
		writeFileSync(join(root, "AGENTS.md"), "private rules\n");
		assert.deepEqual(recordHostProblems({ temp, home: join(root, "elsewhere") }), [
			`${join(root, "AGENTS.md")} is above the sandbox temp dir ${temp}; a recorded prompt would carry it`,
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a record host whose temp dir is inside the real home is refused", () => {
	const home = mkdtempSync(join(tmpdir(), "eq-record-home-"));
	try {
		const temp = join(home, "runs", "tmp");
		mkdirSync(temp, { recursive: true });
		assert.deepEqual(recordHostProblems({ temp, home }), [
			`the sandbox temp dir ${temp} is inside the home dir ${home}; set TMPDIR outside it`,
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
