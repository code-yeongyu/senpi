import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { knipEntryTable } from "./knip-entry-table.test-support.mjs";
import { appendProbes, copyRepo, knipUnusedExports, realTempDir } from "./knip-probe.test-support.mjs";

// knip checks an entry file's exports only when the file comes from a workspace's configured `entry` list in a
// workspace with includeEntryExports; a file it resolves only from a command (a package.json script, a workflow `run:`
// line, a tool config) stays an entry whose exports it never reads (senpi#4421). This test:
//   1. takes the table from knip's own resolved entries (knip-entry-table.test-support.mjs),
//   2. cross-checks knip against a coarse scan of package.json scripts and workflow lines, which can only add: a source
//      file the scan sees on a command line that knip does not list as an entry of any kind fails the test by name,
//   3. appends one unused export to every table file in a temp copy, runs knip once with the copy's knip.jsonc byte for
//      byte the one CI runs, and requires every probe reported, except in files a file-level baseline ignore covers
//      (knip's own IssueCollector decides which; check-knip-export-coverage.mjs keeps those from growing over checked files).

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_TOKEN = /[\w@./-]+\.(?:[cm]?[jt]s|tsx)(?![\w-])/g;
const EXECUTOR_LINE = /\b(?:node|bun|bunx|tsx|npx|deno)\b/;

// A gitignored path is a build output (e.g. `dist/bun/cli.js`, which `build:binary` compiles after `npm run build`), not
// source: knip honors .gitignore, so it can never list one as an entry, and whether it exists on disk depends only on
// whether a build ran first. The scan skips such paths so its result is the same on a clean and a built checkout.
function gitIgnored(files) {
	if (files.length === 0) return new Set();
	const { status, stdout, stderr } = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: repo, input: files.join("\n"), encoding: "utf8" });
	// git check-ignore exits 0 when some path is ignored, 1 when none is, and anything else on an error.
	assert.ok(status === 0 || status === 1, `git check-ignore failed (${status}): ${stderr}`);
	const out = stdout.trim();
	return new Set(out === "" ? [] : out.split("\n"));
}

// Every source path that appears on a line that runs an executor, resolved against the line's package directory and
// every workspace directory (a command may `cd`, pass `--cwd` or set working-directory). It over-matches on
// purpose; paths that are not files or are gitignored build outputs are dropped, and nothing it finds ever removes a
// table entry.
function scannedRunByPath(workspaceDirs) {
	const lines = [];
	for (const dir of workspaceDirs) {
		const scripts = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")).scripts ?? {};
		for (const [name, command] of Object.entries(scripts)) lines.push({ text: command, bases: [dir, ...workspaceDirs], source: `${dir}/package.json#${name}` });
	}
	const workflows = join(repo, ".github/workflows");
	for (const file of readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f))) {
		readFileSync(join(workflows, file), "utf8")
			.split("\n")
			.forEach((text, index) => lines.push({ text, bases: [".", ...workspaceDirs], source: `.github/workflows/${file}:${index + 1}` }));
	}
	const found = new Map();
	for (const { text, bases, source } of lines) {
		if (!EXECUTOR_LINE.test(text)) continue;
		for (const token of text.match(SOURCE_TOKEN) ?? []) {
			if (token.includes("node_modules/")) continue;
			for (const base of bases) {
				const file = relative(repo, resolve(repo, base, token));
				if (file.startsWith("..") || !existsSync(join(repo, file)) || !statSync(join(repo, file)).isFile()) continue;
				if (!found.has(file)) found.set(file, new Set());
				found.get(file).add(source);
			}
		}
	}
	for (const file of gitIgnored([...found.keys()])) found.delete(file);
	return found;
}

test("the run-by-path scan drops gitignored build outputs and keeps tracked source", () => {
	const buildOutput = "packages/coding-agent/dist/bun/cli.js";
	const source = "packages/coding-agent/src/cli.ts";
	assert.deepEqual([...gitIgnored([buildOutput, source])], [buildOutput]);
	assert.deepEqual([...gitIgnored([])], []);
});

test("knip export-checks every entry it resolves, and every file package.json scripts and CI workflows run by path", async () => {
	const { table, entries, workspaceDirs } = await knipEntryTable(repo);
	assert.ok(table.length > 0, "knip reported no entry files; the knip-entry-table hook no longer sees ProjectPrincipal entries");
	assert.ok(entries.some(({ kinds }) => kinds.includes("resolved")), "no command-resolved entries recorded; the knip-entry-table hook is broken");
	const inTable = new Set(table.map(({ file }) => file));
	const knipKinds = new Map(entries.map(({ file, kinds }) => [file, kinds.join("+")]));
	const scanned = scannedRunByPath(workspaceDirs);
	console.log(`knip-entry-crosscheck: ${scanned.size} files seen run by path, ${entries.length} knip entries, ${table.length} in the probe table`);
	const gaps = [...scanned]
		.filter(([file]) => !knipKinds.has(file))
		.map(([file, sources]) => `${file} (run by ${[...sources].join(", ")})`);
	assert.deepEqual(gaps, [], "files run by path that knip does not list as entries; list each under its workspace's `entry` in knip.jsonc");

	const work = realTempDir("knip-entry-probe-");
	try {
		copyRepo(repo, work);
		assert.equal(readFileSync(join(work, "knip.jsonc"), "utf8"), readFileSync(join(repo, "knip.jsonc"), "utf8"), "the probe copy must run the knip.jsonc CI runs");
		const probed = table.filter(({ exportsIgnored }) => !exportsIgnored);
		const probes = appendProbes(work, probed.map(({ file }) => file), "zzKnipProbe_");
		assert.equal(probes.length, probed.length, "a table file is a symlink; probe its target instead");
		const reported = knipUnusedExports(repo, work);
		const missing = probes.filter(({ file, name }) => !reported.has(`${file}#${name}`)).map(({ file }) => `${file} (knip: ${knipKinds.get(file)})`);
		console.log(`knip-entry-probe: ${probes.length} knip entries probed, ${probes.length - missing.length} reported, ${table.length - probed.length} under a file-level exports baseline ignore`);
		assert.deepEqual(missing, [], "entries whose exports knip does not check; list each under its workspace's `entry` in a workspace with includeEntryExports");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
