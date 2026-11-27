import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { finishRecord, summarizeRun } from "./equivalence-deferred.mjs";
import { CONTEXT_WRAPPERS, goldenLeaks, recordHostProblems, writeIfClean } from "./equivalence-record-guard.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const recorder = join(repoRoot, ".agents", "skills", "senpi-qa", "scripts", "scenarios", "fused-equivalence-qa.mjs");

const golden = (systemPrompt) =>
	`${JSON.stringify({ id: "E08", observations: { O1: [{ body: { messages: [{ content: systemPrompt }] } }] } }, null, 1)}\n`;
const markers = (text, home) => goldenLeaks(text, home).map((leak) => leak.marker);

function withRoot(run) {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "eq-record-guard-")));
	try {
		return run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a golden carrying senpi's context or rules wrapper is refused", () => {
	assert.deepEqual(markers(golden('<project_context>\n<project_instructions path="x">\nhi\n</project_instructions>')), [
		"<project_context>",
		"<project_instructions",
	]);
	assert.deepEqual(markers(golden("<project_rules>\nhi\n</project_rules>")), ["<project_rules>"]);
});

test("a golden naming a context file in any letter case is refused", () => {
	for (const name of ["AGENTS.override.md", "AGENTS.MD", "claude.md"])
		assert.equal(goldenLeaks(golden(`read ${name}`)).length, 1, name);
});

test("a golden naming a home path or the recording user's home dir is refused", () => {
	for (const path of ["/Users/a/w", "/users/a/w", "/home/a/w", "/root/w", "C:\\Users\\a\\w"])
		assert.equal(goldenLeaks(golden(`cwd: ${path}`)).length, 1, path);
	assert.deepEqual(markers(golden("cwd: /srv/people/alice/work"), "/srv/people/alice"), ["/srv/people/alice"]);
});

test("a golden made of sandbox placeholders only is accepted", () => {
	assert.deepEqual(goldenLeaks(golden("You are senpi.\ncwd: <sandbox>/work"), "/srv/people/alice"), []);
});

test("the wrappers the guard scans for are the ones senpi's system prompt writes", () => {
	const source = readFileSync(join(repoRoot, "packages", "coding-agent", "src", "core", "system-prompt.ts"), "utf8");
	for (const wrapper of CONTEXT_WRAPPERS.slice(0, 2)) assert.ok(source.includes(wrapper), wrapper);
});

test("a rule file in the sandbox temp dir itself, or above it in any letter case, refuses the host", () =>
	withRoot((root) => {
		const temp = join(root, "runs", "tmp");
		mkdirSync(temp, { recursive: true });
		const home = join(root, "elsewhere");
		assert.deepEqual(recordHostProblems({ temp, home }), []);
		for (const path of [join(temp, "AGENTS.override.md"), join(root, "runs", "CLAUDE.MD"), join(root, "AGENTS.MD")]) {
			writeFileSync(path, "private\n");
			assert.deepEqual(recordHostProblems({ temp, home }), [
				`${path} is at or above the sandbox temp dir ${temp}; a recorded prompt would carry it`,
			]);
			rmSync(path);
		}
		mkdirSync(join(root, ".claude", "rules"), { recursive: true });
		assert.equal(recordHostProblems({ temp, home }).length, 1);
	}));

test("a temp dir reached through a symlink is checked at its real path", () =>
	withRoot((root) => {
		const real = join(root, "real", "tmp");
		mkdirSync(real, { recursive: true });
		writeFileSync(join(root, "real", "AGENTS.md"), "private\n");
		symlinkSync(join(root, "real"), join(root, "link"));
		assert.deepEqual(recordHostProblems({ temp: join(root, "link", "tmp"), home: join(root, "elsewhere") }), [
			`${join(root, "real", "AGENTS.md")} is at or above the sandbox temp dir ${real}; a recorded prompt would carry it`,
		]);
	}));

test("a temp dir inside the home dir refuses the host", () =>
	withRoot((home) => {
		const temp = join(home, "runs", "tmp");
		mkdirSync(temp, { recursive: true });
		assert.deepEqual(recordHostProblems({ temp, home }), [
			`the sandbox temp dir ${temp} is inside the home dir ${home}; set TMPDIR outside it`,
		]);
	}));

test("the recorder refuses such a host before any case runs", () =>
	withRoot((root) => {
		const temp = join(root, "tmp");
		mkdirSync(temp);
		writeFileSync(join(root, "AGENTS.md"), "private\n");
		const run = spawnSync(process.execPath, [recorder, "--record", "--placement", "fused", "--cases", "E01"], {
			cwd: repoRoot,
			env: { ...process.env, TMPDIR: temp },
			encoding: "utf8",
			timeout: 60_000,
		});
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /refusing to record on this host:\n.*AGENTS\.md is at or above the sandbox temp dir/);
		assert.doesNotMatch(run.stdout, /\[(PASS|FAIL)\] E01/);
	}));

test("a leaky golden is not written and the write reports why", () =>
	withRoot((root) => {
		const path = join(root, "E08.json");
		const refusal = writeIfClean(path, golden("<project_rules>\nprivate\n</project_rules>"), "/srv/people/alice");
		assert.match(refusal, /^E08\.json refused, it carries host-private text: <project_rules> x1/);
		assert.equal(existsSync(path), false);
		assert.equal(writeIfClean(path, golden("clean"), "/srv/people/alice"), undefined);
		assert.equal(readFileSync(path, "utf8"), golden("clean"));
	}));

test("a leaky baseline manifest is not written and the record run fails", () =>
	withRoot((dir) => {
		const manifest = { command: "node fused-equivalence-qa.mjs --record --child binary:/home/alice/senpi" };
		const results = [{ id: "E01", pass: true, written: true }];
		const unrecorded = finishRecord({ dir, results, leaveUnrecorded: [], manifest });
		assert.equal(unrecorded.length, 1);
		assert.match(unrecorded[0], /^baseline\.json refused, it carries host-private text: \/home\/ x1/);
		assert.equal(existsSync(join(dir, "baseline.json")), false);
		assert.equal(summarizeRun(results, [], "record", unrecorded).exitCode, 1);
	}));

test("the recorder writes goldens only through the scanned write path", () => {
	const source = readFileSync(recorder, "utf8");
	assert.match(source, /error = writeIfClean\(goldenPath, serialized\);/);
	assert.doesNotMatch(source, /writeFileSync\(\s*goldenPath/);
});
