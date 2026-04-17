#!/usr/bin/env node
// Run `check` inside packages/web-ui using whichever package manager invoked
// us, stripping pnpm-only `npm_config_*` env keys so the sub-build doesn't
// emit `npm warn Unknown env config ...` noise under pnpm or bun.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webUiDir = join(dirname(__dirname), "packages/web-ui");

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

function detectPm() {
	const execpath = process.env.npm_execpath;
	const userAgent = process.env.npm_config_user_agent ?? "";
	if (execpath && /bun/i.test(execpath)) return { cmd: "bun", execpath };
	if (userAgent.startsWith("bun/")) return { cmd: "bun", execpath: undefined };
	if (execpath && /pnpm/i.test(execpath)) return { cmd: "pnpm", execpath };
	if (userAgent.startsWith("pnpm/")) return { cmd: "pnpm", execpath: undefined };
	if (execpath) return { cmd: "npm", execpath };
	return { cmd: "npm", execpath: undefined };
}

const pm = detectPm();
// bun's execpath is a native binary, npm/pnpm are .js we load via Node.
function runCheck() {
	if (pm.execpath && pm.cmd === "bun") {
		return spawnSync(pm.execpath, ["run", "check"], { cwd: webUiDir, stdio: "inherit", env, shell: false });
	}
	if (pm.execpath) {
		return spawnSync(process.execPath, [pm.execpath, "run", "check"], { cwd: webUiDir, stdio: "inherit", env, shell: false });
	}
	return spawnSync(pm.cmd, ["run", "check"], { cwd: webUiDir, stdio: "inherit", env, shell: false });
}
process.exit(runCheck().status ?? 1);
