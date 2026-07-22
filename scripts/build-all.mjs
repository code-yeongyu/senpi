#!/usr/bin/env node
// PM-agnostic monorepo build orchestrator.
//
// The previous root `build` script hardcoded `npm run build` while cd-ing
// through packages. When invoked under pnpm or bun, the child npm process
// inherited pnpm/bun-specific `npm_config_*` env vars from the parent and
// printed a wall of `npm warn Unknown env config ...` noise. This script
// uses whichever package manager actually invoked the parent (detected via
// $npm_execpath), and strips the cross-PM env keys before spawning so the
// output of `npm run build` / `pnpm run build` / `bun run build` all stay
// clean.
//
// Usage: node scripts/build-all.mjs [--pm npm|bun|pnpm]

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const SUPPORTED_PMS = new Set(["npm", "bun", "pnpm"]);

export const BUILD_PHASES = [
	["packages/tui", "packages/pty", "packages/ai"],
	["packages/agent", "packages/storage/sqlite-node"],
	["packages/coding-agent", "packages/web-ui"],
	["packages/server"],
];

export function parseArgs(argv) {
	let pm;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pm") {
			pm = argv[++i];
			continue;
		}
		if (arg.startsWith("--pm=")) {
			pm = arg.slice("--pm=".length);
			continue;
		}
		console.error(`unknown argument: ${arg}`);
		process.exit(2);
	}
	if (pm && !SUPPORTED_PMS.has(pm)) {
		console.error(`unknown package manager: ${pm}`);
		console.error(`supported: ${[...SUPPORTED_PMS].join(", ")}`);
		process.exit(2);
	}
	return { pm };
}

export function detectPackageManager(env = process.env, forcedPm) {
	if (forcedPm) return { cmd: forcedPm, execpath: undefined };

	const execpath = env.npm_execpath;
	const userAgent = env.npm_config_user_agent ?? "";

	if (execpath && /bun/i.test(execpath)) return { cmd: "bun", execpath };
	if (userAgent.startsWith("bun/")) return { cmd: "bun", execpath: undefined };
	if (execpath && /pnpm/i.test(execpath)) return { cmd: "pnpm", execpath };
	if (userAgent.startsWith("pnpm/")) return { cmd: "pnpm", execpath: undefined };
	if (execpath) return { cmd: "npm", execpath };
	return { cmd: "npm", execpath: undefined };
}

export function cleanEnv(envSource = process.env) {
	// pnpm exports every .npmrc key as a lowercased npm_config_* env var and
	// normalizes dashes to underscores. When the parent is pnpm and the
	// child is npm (e.g. one of these builds still shells out to npm
	// internally), npm warns for each unknown key. Strip the keys that
	// only pnpm understands before spawning children so the build output
	// stays clean regardless of PM.
	const PNPM_ONLY_KEYS = new Set([
		"node_linker",
		"link_workspace_packages",
		"prefer_workspace_packages",
		"verify_deps_before_run",
		"_jsr_registry",
		"npm_globalconfig",
	]);
	const env = { ...envSource };
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (!lower.startsWith("npm_config_")) continue;
		const stripped = lower.slice("npm_config_".length);
		if (PNPM_ONLY_KEYS.has(stripped)) delete env[key];
	}
	return env;
}

function spawnPmAsync(pm, args, cwd, env) {
	// bun's execpath is a native binary so we invoke it directly.
	// npm's and pnpm's execpaths are .js / .cjs entry points that have to
	// be loaded through the current Node runtime, unless they are native binaries (like pnpm.exe).
	let command = pm.cmd;
	let spawnArgs = args;
	if (pm.execpath && (pm.cmd === "bun" || !/\.[cm]?js$/i.test(pm.execpath))) {
		command = pm.execpath;
	} else if (pm.execpath) {
		command = process.execPath;
		spawnArgs = [pm.execpath, ...args];
	}

	return new Promise((resolve) => {
		const child = spawn(command, spawnArgs, { cwd, stdio: "inherit", env, shell: false });
		child.on("error", (error) => {
			console.error(`\n[build-all] failed to spawn ${pm.cmd}: ${error.message}`);
			resolve(1);
		});
		child.on("close", (status) => resolve(status ?? 1));
	});
}

async function runBuild(pm, cwd) {
	const env = cleanEnv();
	const rel = cwd.replace(`${root}/`, "");
	console.log(`[build-all] building ${rel}`);
	const status = await spawnPmAsync(pm, ["run", "build"], cwd, env);
	return { rel, status };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const pm = detectPackageManager(process.env, args.pm);
	for (let i = 0; i < BUILD_PHASES.length; i++) {
		const phase = BUILD_PHASES[i];
		console.log(`\n[build-all] phase ${i + 1}: ${phase.join(", ")}`);
		const results = await Promise.all(phase.map((rel) => runBuild(pm, join(root, rel))));
		const failed = results.find((result) => result.status !== 0);
		if (failed) {
			console.error(`\n[build-all] build failed in ${failed.rel} (exit ${failed.status})`);
			process.exit(failed.status);
		}
	}

	// Root shim refresh lives in a separate script.
	const wrapperResult = spawnSync(
		process.execPath,
		[join(root, "scripts/create-root-senpi-wrapper.mjs")],
		{ cwd: root, stdio: "inherit", env: cleanEnv(), shell: false },
	);
	if (wrapperResult.status !== 0) process.exit(wrapperResult.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
