#!/usr/bin/env node
// Shared package-manager plumbing for the root orchestration scripts.
//
// Root scripts are launched by whichever package manager the contributor uses
// (`npm run`, `bun run`, `pnpm run`), and every child they spawn must use that
// same manager: hardcoding `npm` under bun or pnpm makes the child inherit
// cross-PM `npm_config_*` env vars (a wall of `npm warn Unknown env config`
// noise) and silently changes which runtime executes the workspace script.
// `build-all.mjs` and `run-workspaces.mjs` both route through this module so
// detection and spawning live in exactly one place.

import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";

export const SUPPORTED_PACKAGE_MANAGERS = ["npm", "bun", "pnpm"];

export function detectPackageManager(env = process.env, forcedPm) {
	if (forcedPm) return { cmd: forcedPm, execpath: undefined };

	// The user agent names the manager outright (`bun/1.4.0 ...`, `pnpm/10.32.1 ...`,
	// `npm/11.19.0 ...`). The execpath is only a fallback and is judged by its
	// basename: a pnpm installed through `bun install -g` lives under ~/.bun/bin,
	// so matching "bun" anywhere in the path would misreport it.
	const execpath = env.npm_execpath;
	const userAgent = env.npm_config_user_agent ?? "";
	const fromUserAgent = SUPPORTED_PACKAGE_MANAGERS.find((name) => userAgent.startsWith(`${name}/`));
	const executable = execpath ? basename(execpath).toLowerCase() : "";
	let fromExecpath;
	if (/^bun(\.exe)?$/.test(executable)) fromExecpath = "bun";
	else if (/pnpm/.test(executable)) fromExecpath = "pnpm";
	else if (execpath) fromExecpath = "npm";

	return { cmd: fromUserAgent ?? fromExecpath ?? "npm", execpath };
}

export function cleanEnv(envSource = process.env) {
	// pnpm exports every .npmrc key as a lowercased npm_config_* env var and
	// normalizes dashes to underscores. When the parent is pnpm and the
	// child is npm (e.g. one of these builds still shells out to npm
	// internally), npm warns for each unknown key. Strip the keys that
	// only pnpm understands before spawning children so the output
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

/**
 * Resolves the executable and argv for a package-manager invocation.
 *
 * bun's execpath is a native binary, so it is invoked directly. npm's and
 * pnpm's execpaths are .js / .cjs entry points that have to be loaded through
 * the current Node runtime, unless they are native binaries (like pnpm.exe).
 * Without an execpath the manager is resolved by name on PATH.
 */
export function packageManagerInvocation(pm, args) {
	if (pm.execpath && (pm.cmd === "bun" || !/\.[cm]?js$/i.test(pm.execpath))) {
		return { command: pm.execpath, args };
	}
	if (pm.execpath) {
		return { command: process.execPath, args: [pm.execpath, ...args] };
	}
	return { command: pm.cmd, args };
}

/**
 * argv for `<pm> run <script>` with caller arguments. npm and bun consume the
 * first `--` and forward what follows to the script; pnpm forwards everything
 * after the script name verbatim, separator included, so it must not receive
 * one (measured on npm 11, bun 1.4, pnpm 10).
 */
export function runScriptArguments(pm, script, forwarded = []) {
	if (forwarded.length === 0) return ["run", script];
	return pm.cmd === "pnpm" ? ["run", script, ...forwarded] : ["run", script, "--", ...forwarded];
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Delivers a signal to the child's whole process group. A package manager runs
 * the script through a shell, and neither the shell nor every manager forwards
 * signals (npm -> sh -> node leaves node running), so signalling only the
 * direct child orphans the real work. The child is spawned as its own group
 * leader (`detached`), so the negative-pid kill reaches every descendant at
 * once with no dependence on process-listing timing. Windows has no process
 * groups or catchable SIGTERM, so the tree is terminated through taskkill.
 *
 * The process primitives are parameters so both platform branches run under
 * test on every runner; production callers pass nothing.
 */
export function signalGroup(
	child,
	signal,
	{ platform = process.platform, kill = process.kill, spawnSync: spawnSyncImpl = spawnSync } = {},
) {
	if (child.pid === undefined) return;
	try {
		if (platform === "win32") {
			spawnSyncImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			kill(-child.pid, signal);
		}
	} catch {
		// the group is already gone
	}
}

/**
 * Spawns `<pm> <args>` in `cwd` with inherited stdio and resolves with the exit
 * status (1 when the child died on a signal or could not be spawned at all).
 *
 * Termination signals are forwarded to the child's process group so a watcher
 * started through a root script dies with Ctrl-C instead of surviving as an
 * orphan; once the child is gone the same signal is re-raised on this process,
 * which then ends the way a plain script would, without running further
 * workspaces.
 */
export function spawnPackageManager(pm, args, { cwd, env, label }) {
	const invocation = packageManagerInvocation(pm, args);
	return new Promise((resolve) => {
		const detached = process.platform !== "win32";
		const child = spawn(invocation.command, invocation.args, { cwd, stdio: "inherit", env, shell: false, detached });
		let forwarded;
		const handlers = new Map(
			FORWARDED_SIGNALS.map((signal) => [
				signal,
				() => {
					forwarded = signal;
					signalGroup(child, signal);
				},
			]),
		);
		for (const [signal, handler] of handlers) process.on(signal, handler);
		const release = () => {
			for (const [signal, handler] of handlers) process.off(signal, handler);
		};
		child.on("error", (error) => {
			release();
			console.error(`\n[${label}] failed to spawn ${pm.cmd}: ${error.message}`);
			resolve(1);
		});
		child.on("close", (status) => {
			release();
			if (forwarded) {
				process.kill(process.pid, forwarded);
				return;
			}
			resolve(status ?? 1);
		});
	});
}
