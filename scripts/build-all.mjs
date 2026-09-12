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
// clean. Detection and spawning are shared with run-workspaces.mjs through
// package-manager.mjs.
//
// Usage: node scripts/build-all.mjs [--pm npm|bun|pnpm]

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cleanEnv, detectPackageManager, spawnPackageManager, SUPPORTED_PACKAGE_MANAGERS } from "./package-manager.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const SUPPORTED_PMS = new Set(SUPPORTED_PACKAGE_MANAGERS);

export const BUILD_PHASES = [
	["packages/tui", "packages/pty", "packages/telemetry", "packages/protocol"],
	["packages/ai", "packages/client"],
	["packages/agent"],
	["packages/session-backends/sqlite-node"],
	["packages/coding-agent"],
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

async function runBuild(pm, cwd) {
	const env = cleanEnv();
	const rel = cwd.replace(`${root}/`, "");
	console.log(`[build-all] building ${rel}`);
	const status = await spawnPackageManager(pm, ["run", "build"], { cwd, env, label: "build-all" });
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
