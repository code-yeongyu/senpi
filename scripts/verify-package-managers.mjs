#!/usr/bin/env node
// Multi-package-manager install+build verifier.
//
// Snapshots the current working tree (staged + unstaged) to an isolated
// temp dir per package manager, removes lockfiles that don't belong to the
// target package manager, then runs `install` and `run build:<pm>` there.
// Requested PMs run in parallel (default: npm, bun, pnpm). Local
// node_modules/dist are never touched.
//
// Usage:
//   node scripts/verify-package-managers.mjs                 # all three
//   node scripts/verify-package-managers.mjs npm             # subset
//   node scripts/verify-package-managers.mjs --keep-tmp bun  # keep temp
//     dir on failure for inspection (prints path)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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

export async function snapshotRepo(dest, source = ROOT) {
	const excluded = new Set(["node_modules", ".git", "dist", ".worktrees", "local-ignore", ".pi", ".opencode"]);
	await cp(source, dest, {
		recursive: true,
		preserveTimestamps: true,
		verbatimSymlinks: true,
		filter: (path) => {
			const pathParts = relative(source, path).split(sep);
			const relativePath = pathParts.join("/");
			return (
				!pathParts.some((part) => excluded.has(part)) &&
				relativePath !== ".husky/_" &&
				relativePath !== "packages/coding-agent/binaries" &&
				!relativePath.endsWith(".log") &&
				!relativePath.endsWith(".tsbuildinfo")
			);
		},
	});
}

function runAsync(command, args, cwd = ROOT, env = process.env) {
	return new Promise((resolve) => {
		const shell = process.platform === "win32";
		// Windows npm/pnpm shims need cmd; PM names and these arguments are fixed by the verifier.
		const child = spawn(shell ? [command, ...args].join(" ") : command, shell ? [] : args, {
			cwd,
			stdio: "inherit",
			env,
			shell,
		});
		child.on("error", (error) => {
			console.error(`\n[${command}] failed to spawn: ${error.message}`);
			resolve(1);
		});
		child.on("close", (status) => resolve(status ?? 1));
	});
}

async function runPM(pm, args, cwd) {
	return runAsync(pm, args, cwd, { ...process.env, CI: "1" });
}

async function verify(pm, parentTmp) {
	const tmp = mkdtempSync(join(parentTmp, `${pm}-`));
	header(`[${pm}] snapshot repo to ${tmp}`);
	await snapshotRepo(tmp);

	// Remove the npm lockfile when using bun or pnpm so they resolve from
	// package.json alone. Their own lockfiles (if present in the working
	// tree) come along in the snapshot and are respected.
	if (pm !== "npm") {
		const lock = join(tmp, "package-lock.json");
		if (existsSync(lock)) rmSync(lock, { force: true });
	}

	header(`[${pm}] install`);
	const installArgs = pm === "pnpm" ? ["install", "--ignore-scripts"] : ["install"];
	const inst = await runPM(pm, installArgs, tmp);
	if (inst !== 0) return { pm, ok: false, stage: "install", tmp };

	header(`[${pm}] run build:${pm}`);
	const build = await runPM(pm, ["run", `build:${pm}`], tmp);
	if (build !== 0) return { pm, ok: false, stage: "build", tmp };

	return { pm, ok: true, tmp };
}

async function main() {
	const { pms, flags } = parseArgs();
	const parentTmp = mkdtempSync(join(tmpdir(), "verify-pms-"));

	header(`Verifying: ${pms.join(", ")}`);
	const toClean = [parentTmp];
	let results;
	try {
		results = await Promise.all(pms.map((pm) => verify(pm, parentTmp)));
		for (const result of results) {
			if (result.ok || !flags.keepTmp) rmSync(result.tmp, { recursive: true, force: true });
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

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
