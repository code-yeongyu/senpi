// The fixture task's checker (plan §3.4 SC-LIVE): run in the session's work dir after the run. PASS only when every
// test under test/ passes (`node --test`) and NOTES.md holds the lines TASK.md asks for, in order.
//   node check.mjs <work dir> [--license <answer>]  ->  prints one JSON verdict, exit 0 only on PASS
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The answer the harness gives the fixture's license question (live-session-qa answers with this label). */
export const LICENSE_ANSWER = "MIT";

const NOTE_LINES = [
	{ id: "duration-2d", pattern: /^duration: 2 days = 172800000\b/ },
	{ id: "duration-90m", pattern: /^duration: 90m = 5400000\b/ },
	{ id: "mcp", pattern: /^mcp: \S.*/ },
	{
		id: "license",
		pattern: (license) => new RegExp(`^license: ${license.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`),
	},
	{ id: "subagent", pattern: /^subagent: \S.*/ },
];

/** @returns {{ pass: boolean, failures: string[], tests: { status: number | null } }} */
export function checkTask(workDir, { license = LICENSE_ANSWER } = {}) {
	const failures = [];
	const tests = spawnSync(process.execPath, ["--test"], { cwd: workDir, encoding: "utf8", timeout: 120_000 });
	if (tests.status !== 0) failures.push(`tests: node --test exited ${tests.status ?? tests.signal}`);
	const notesPath = join(workDir, "NOTES.md");
	const lines = existsSync(notesPath)
		? readFileSync(notesPath, "utf8")
				.split("\n")
				.map((line) => line.trim().replace(/^[-*]\s+/, ""))
				.filter(Boolean)
		: [];
	if (lines.length === 0) failures.push("notes: NOTES.md is missing or empty");
	let cursor = 0;
	for (const { id, pattern } of NOTE_LINES) {
		const regex = typeof pattern === "function" ? pattern(license) : pattern;
		const found = lines.findIndex((line, index) => index >= cursor && regex.test(line));
		if (found < 0) failures.push(`notes: no ${id} line (in order) matching ${regex}`);
		else cursor = found + 1;
	}
	return { pass: failures.length === 0, failures, tests: { status: tests.status } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [workDir, flag, license] = process.argv.slice(2);
	if (!workDir) throw new Error("usage: check.mjs <work dir> [--license <answer>]");
	const verdict = checkTask(workDir, flag === "--license" ? { license } : {});
	process.stdout.write(`${JSON.stringify(verdict)}\n`);
	process.exitCode = verdict.pass ? 0 : 1;
}
