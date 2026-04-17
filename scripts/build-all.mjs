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
// Usage: node scripts/build-all.mjs

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

const BUILD_ORDER = [
	"packages/tui",
	"packages/ai",
	"packages/agent",
	"packages/coding-agent",
	"packages/mom",
	"packages/web-ui",
	"packages/pods",
];

function detectPackageManager() {
	const execpath = process.env.npm_execpath;
	const userAgent = process.env.npm_config_user_agent ?? "";

	if (execpath && /bun/i.test(execpath)) return { cmd: "bun", execpath };
	if (userAgent.startsWith("bun/")) return { cmd: "bun", execpath: undefined };
	if (execpath && /pnpm/i.test(execpath)) return { cmd: "pnpm", execpath };
	if (userAgent.startsWith("pnpm/")) return { cmd: "pnpm", execpath: undefined };
	if (execpath) return { cmd: "npm", execpath };
	return { cmd: "npm", execpath: undefined };
}

function cleanEnv() {
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
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (!lower.startsWith("npm_config_")) continue;
		const stripped = lower.slice("npm_config_".length);
		if (PNPM_ONLY_KEYS.has(stripped)) delete env[key];
	}
	return env;
}

function spawnPm(pm, args, cwd, env) {
	// bun's execpath is a native binary so we invoke it directly.
	// npm's and pnpm's execpaths are .js / .cjs entry points that have to
	// be loaded through the current Node runtime.
	if (pm.execpath && pm.cmd === "bun") {
		return spawnSync(pm.execpath, args, { cwd, stdio: "inherit", env, shell: false });
	}
	if (pm.execpath) {
		return spawnSync(process.execPath, [pm.execpath, ...args], { cwd, stdio: "inherit", env, shell: false });
	}
	return spawnSync(pm.cmd, args, { cwd, stdio: "inherit", env, shell: false });
}

function runBuild(pm, cwd) {
	const env = cleanEnv();
	const result = spawnPm(pm, ["run", "build"], cwd, env);
	if (result.status !== 0) {
		const rel = cwd.replace(`${root}/`, "");
		console.error(`\n[build-all] build failed in ${rel} (exit ${result.status})`);
		process.exit(result.status ?? 1);
	}
}

const pm = detectPackageManager();
for (const rel of BUILD_ORDER) {
	runBuild(pm, join(root, rel));
}

// Root shim refresh lives in a separate script.
const wrapperResult = spawnSync(
	process.execPath,
	[join(root, "scripts/create-root-senpi-wrapper.mjs")],
	{ cwd: root, stdio: "inherit", env: cleanEnv(), shell: false },
);
if (wrapperResult.status !== 0) process.exit(wrapperResult.status ?? 1);
