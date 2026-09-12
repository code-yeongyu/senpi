#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { WORKSPACE_PACKAGES } from "./release-packages.mjs";
import { CHANGELOGS } from "./release-changelog.mjs";

for (const mergeStatus of [0, 1]) {
	it(`release CLI recovers concurrent main advancement and respects merge exit ${mergeStatus}`, () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-release-cli-"));
		try {
			for (const file of WORKSPACE_PACKAGES) {
				mkdirSync(dirname(join(root, file)), { recursive: true });
				writeFileSync(join(root, file), JSON.stringify({ version: "2026.9.12-2" }));
			}
			for (const file of CHANGELOGS) {
				writeFileSync(join(root, file), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixture.\n");
			}
			const bin = join(root, "bin");
			mkdirSync(bin);
			const calls = join(root, "commands.jsonl");
			for (const name of ["git", "npm", "node", "bun", "gh"]) {
				const body = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
if (${JSON.stringify(name)} === "git") {
	if (args[0] === "branch") process.stdout.write("main\\n");
	if (args[0] === "rev-parse") process.stdout.write("fixture-sha\\n");
	if (args[0] === "merge-base") process.exit(1);
	if (args[0] === "merge") process.exit(${mergeStatus});
}
if (${JSON.stringify(name)} === "gh") process.stdout.write("[]");
`;
				const runner = join(bin, `${name}.mjs`);
				writeFileSync(runner, body);
				if (process.platform === "win32") {
					writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${runner}" %*\r\n`);
				} else {
					writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`);
					chmodSync(join(bin, name), 0o755);
				}
			}
			const result = spawnSync(process.execPath, [fileURLToPath(new URL("./release.mjs", import.meta.url)), "--version", "2026.9.12-3"], {
				cwd: root,
				env: { ...process.env, PATH: `${bin}${delimiter}${dirname(process.execPath)}` },
				encoding: "utf8",
				timeout: 15000,
			});
			const commands = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
			assert.ok(commands.some((args) => args[0] === "git" && args[1] === "merge"), result.stderr);
			assert.equal(result.status, mergeStatus, result.stderr);
			assert.deepEqual(commands.filter((args) => args[1] === "push"), mergeStatus === 0 ? [
				["git", "push", "origin", "main"],
				["git", "push", "origin", "v2026.9.12-3"],
			] : []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
