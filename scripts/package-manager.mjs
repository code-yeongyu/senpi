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
 * One set of signal handlers shared by every child of a parallel run. Each
 * forwarded signal reaches every attached child's process group; the caller
 * re-raises the recorded signal once all children are gone, so the first child
 * to exit cannot take the driver down while its siblings are still draining.
 */
export function createSignalFanout() {
	const children = new Set();
	let forwarded;
	const handlers = new Map(
		FORWARDED_SIGNALS.map((signal) => [
			signal,
			() => {
				forwarded = signal;
				for (const child of children) signalGroup(child, signal);
			},
		]),
	);
	for (const [signal, handler] of handlers) process.on(signal, handler);
	return {
		attach: (child) => children.add(child),
		detach: (child) => children.delete(child),
		/** Removes the handlers and returns the forwarded signal, if any. */
		release() {
			for (const [signal, handler] of handlers) process.off(signal, handler);
			return forwarded;
		},
	};
}

/** Writes every line of `stream` to `target` as `[prefix] line`, flushing a trailing partial line. */
function prefixLines(stream, prefix, target) {
	let pending = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		pending += chunk;
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			target.write(`[${prefix}] ${pending.slice(0, newline)}\n`);
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
	});
	stream.on("end", () => {
		if (pending.length > 0) target.write(`[${prefix}] ${pending}\n`);
	});
}

/**
 * Spawns `<pm> <args>` in `cwd` and resolves with the exit status (1 when the
 * child died on a signal or could not be spawned at all).
 *
 * Without options the child inherits stdio and owns the signal handling:
 * termination signals are forwarded to its process group so a watcher started
 * through a root script dies with Ctrl-C instead of surviving as an orphan, and
 * once the child is gone the same signal is re-raised on this process, which
 * then ends the way a plain script would, without running further workspaces.
 *
 * `prefix` pipes stdout/stderr and tags every line `[prefix]` so concurrent
 * children stay attributable. `fanout` (from `createSignalFanout`) replaces the
 * per-child handlers: the child is attached for the run's shared forwarding and
 * the caller re-raises after every child has closed.
 */
export function spawnPackageManager(pm, args, { cwd, env, label, prefix, fanout }) {
	const invocation = packageManagerInvocation(pm, args);
	return new Promise((resolve) => {
		const detached = process.platform !== "win32";
		const stdio = prefix === undefined ? "inherit" : ["inherit", "pipe", "pipe"];
		const child = spawn(invocation.command, invocation.args, { cwd, stdio, env, shell: false, detached });
		if (prefix !== undefined) {
			prefixLines(child.stdout, prefix, process.stdout);
			prefixLines(child.stderr, prefix, process.stderr);
		}
		let forwarded;
		const handlers = new Map(
			fanout
				? []
				: FORWARDED_SIGNALS.map((signal) => [
						signal,
						() => {
							forwarded = signal;
							signalGroup(child, signal);
						},
					]),
		);
		for (const [signal, handler] of handlers) process.on(signal, handler);
		fanout?.attach(child);
		const release = () => {
			for (const [signal, handler] of handlers) process.off(signal, handler);
			fanout?.detach(child);
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
