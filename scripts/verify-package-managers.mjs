#!/usr/bin/env node
// Multi-package-manager install+build verifier.
//
// Snapshots the current working tree (staged + unstaged) to an isolated
// temp dir, removes lockfiles that don't belong to the target package
// manager, then runs `install` and `run build` there. Repeats for every
// requested PM (default: npm, bun, pnpm). Local node_modules/dist are
// never touched.
//
// Usage:
//   node scripts/verify-package-managers.mjs                 # all three
//   node scripts/verify-package-managers.mjs npm             # subset
//   node scripts/verify-package-managers.mjs --keep-tmp bun  # keep temp
//     dir on failure for inspection (prints path)

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ALL_PMS = ["npm", "bun", "pnpm"];

function parseArgs() {
	const args = process.argv.slice(2);
	const flags = { keepTmp: false };
	const pms = [];
	for (const a of args) {
		if (a === "--keep-tmp") {
			flags.keepTmp = true;
			continue;
		}
		if (a.startsWith("-")) {
			console.error(`unknown flag: ${a}`);
			process.exit(2);
		}
		if (!ALL_PMS.includes(a)) {
			console.error(`unknown package manager: ${a}`);
			console.error(`supported: ${ALL_PMS.join(", ")}`);
			process.exit(2);
		}
		pms.push(a);
	}
	return { pms: pms.length ? pms : ALL_PMS, flags };
}

function color(code, str) {
	return process.stdout.isTTY ? `\x1b[${code}m${str}\x1b[0m` : str;
}

function header(msg) {
	process.stdout.write(`\n${color("1;36", `==> ${msg}`)}\n`);
}

function snapshotRepo(dest) {
	const result = spawnSync(
		"rsync",
		[
			"-a",
			"--exclude=node_modules",
			"--exclude=.git",
			"--exclude=dist",
			"--exclude=.worktrees",
			"--exclude=.husky/_",
			"--exclude=packages/coding-agent/binaries",
			"--exclude=local-ignore",
			"--exclude=.pi",
			"--exclude=.opencode",
			"--exclude=*.log",
			"--exclude=*.tsbuildinfo",
			`${ROOT}/`,
			`${dest}/`,
		],
		{ stdio: "inherit" },
	);
	if (result.status !== 0) {
		throw new Error(`rsync failed (exit ${result.status})`);
	}
}

function runPM(pm, args, cwd) {
	return spawnSync(pm, args, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, CI: "1" },
	});
}

function verify(pm, parentTmp) {
	const tmp = mkdtempSync(join(parentTmp, `${pm}-`));
	header(`[${pm}] snapshot repo to ${tmp}`);
	snapshotRepo(tmp);

	// Remove the npm lockfile when using bun or pnpm so they resolve from
	// package.json alone. Their own lockfiles (if present in the working
	// tree) come along via rsync and are respected.
	if (pm !== "npm") {
		const lock = join(tmp, "package-lock.json");
		if (existsSync(lock)) rmSync(lock, { force: true });
	}

	header(`[${pm}] install`);
	const inst = runPM(pm, ["install"], tmp);
	if (inst.status !== 0) return { pm, ok: false, stage: "install", tmp };

	header(`[${pm}] run build`);
	const build = runPM(pm, ["run", "build"], tmp);
	if (build.status !== 0) return { pm, ok: false, stage: "build", tmp };

	return { pm, ok: true, tmp };
}

function main() {
	const { pms, flags } = parseArgs();
	const parentTmp = mkdtempSync(join(tmpdir(), "verify-pms-"));

	header(`Verifying: ${pms.join(", ")}`);
	const results = [];
	const toClean = [parentTmp];
	try {
		for (const pm of pms) {
			const result = verify(pm, parentTmp);
			results.push(result);
			if (result.ok || !flags.keepTmp) {
				rmSync(result.tmp, { recursive: true, force: true });
			}
		}
	} catch (err) {
		console.error(`\n${color("1;31", "verify-package-managers.mjs errored:")}`);
		console.error(err);
		for (const p of toClean) rmSync(p, { recursive: true, force: true });
		process.exit(1);
	}

	header("Summary");
	for (const r of results) {
		const mark = r.ok ? color("1;32", "\u2713") : color("1;31", "\u2717");
		const suffix = r.ok ? "" : `  (${r.stage} failed${flags.keepTmp ? `; tmp: ${r.tmp}` : ""})`;
		console.log(`  ${mark} ${r.pm}${suffix}`);
	}

	const allOk = results.every((r) => r.ok);
	if (allOk || !flags.keepTmp) {
		for (const p of toClean) {
			if (existsSync(p)) rmSync(p, { recursive: true, force: true });
		}
	}
	process.exit(allOk ? 0 : 1);
}

main();
