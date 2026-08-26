#!/usr/bin/env node
import "./valid-cwd.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processBunRuntimeOptions, resolveBunReexec } from "./bun-runtime.ts";
import { enableStartupCompileCache } from "./compile-cache.ts";
import { APP_NAME, DISPLAY_VERSION, getPackageDir } from "./config.ts";
import { hasInheritedInspectorOption, releaseInheritedInspectorForChild } from "./inspector-policy.ts";
import { handleBootstrapSelfUpdate } from "./self-update-bootstrap.ts";

/**
 * Hand a Bun-installed CLI to Bun before anything else runs.
 *
 * `bun install -g` links this script into `~/.bun/bin`, but the shebang still starts it on Node,
 * so a user who chose Bun silently gets the Node runtime. Re-exec through the Bun binary when the
 * script really lives in Bun's global tree (or `SENPI_RUNTIME=bun` asks for it). This runs before
 * `enableStartupCompileCache()` on purpose: a re-exec must not pay for Node's compile-cache setup.
 * Node `execArgv` is deliberately dropped — those flags belong to the Node process, not to Bun.
 */
function reexecUnderBunIfNeeded(): boolean {
	const options = processBunRuntimeOptions(existsSync, realpathSync);
	let scriptRealPath = process.argv[1] ?? fileURLToPath(import.meta.url);
	try {
		// `~/.bun/bin/<name>` is a symlink into the global tree, so the link target is what has
		// to be classified and re-executed. A path that cannot be resolved is simply used as-is;
		// runtime selection must never be the reason startup fails.
		scriptRealPath = realpathSync(scriptRealPath);
	} catch {}
	const decision = resolveBunReexec({
		scriptRealPath,
		versions: process.versions,
		hasInheritedInspectorOption: hasInheritedInspectorOption(),
		options,
	});
	if (decision.action === "stay") {
		return false;
	}
	const result = spawnSync(decision.bunPath, [scriptRealPath, ...process.argv.slice(2)], {
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.signal) {
		process.kill(process.pid, result.signal);
		return true;
	}
	process.exitCode = result.status ?? 1;
	return true;
}

if (reexecUnderBunIfNeeded()) {
	process.exit();
}

// Must run before cli-main is loaded, by either path: it caches the engine graph this process
// imports on the fast path below, and it publishes NODE_COMPILE_CACHE so a spawned cli-main child
// inherits this process's cache directory instead of resolving and re-filling its own.
enableStartupCompileCache();

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);
const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

function isRootCommand(args: readonly string[]): boolean {
	const firstArg = args[0];
	return firstArg === undefined || !PACKAGE_COMMANDS.has(firstArg);
}

function isPackageManagerInstall(packageDir: string): boolean {
	return packageDir.replace(/\\/g, "/").includes("/node_modules/@code-yeongyu/senpi");
}

function isMissingBundledWorkspaceDependencies(packageDir: string): boolean {
	if (!isPackageManagerInstall(packageDir)) {
		return false;
	}
	const bundledPackages = ["pi-agent-core", "pi-ai", "pi-tui"];
	return bundledPackages.some((name) => {
		return !existsSync(join(packageDir, "node_modules", "@earendil-works", name, "dist", "index.js"));
	});
}

/**
 * Decide whether the agent needs its own process.
 *
 * Two things justify the extra Node process, and only two. An inherited Inspector option means a
 * debugger socket has to be released here and re-opened over there, which a same-process load
 * cannot do. Custom exec arguments (`--max-old-space-size`, a loader `--import`, ...) were chosen
 * for the process that runs the agent, and they are only applied at process start, so they must be
 * replayed onto a fresh one. Brand scrubbing does NOT justify it: `cli-main` calls
 * `scrubBrandFromEnvironment()` itself, so loading it here scrubs this process's environment before
 * anything the agent spawns can inherit it.
 */
function requiresIsolatedProcess(): boolean {
	return process.execArgv.length > 0 || hasInheritedInspectorOption();
}

async function spawnFullCli(): Promise<number> {
	const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	const fullCliPath = fileURLToPath(new URL(`./cli-main${extension}`, import.meta.url));
	releaseInheritedInspectorForChild();
	return await new Promise<number>((resolve, reject) => {
		const child = spawn(process.execPath, [...process.execArgv, fullCliPath, ...args], {
			env: process.env,
			stdio: "inherit",
		});
		child.on("error", (error) => {
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (signal) {
				process.kill(process.pid, signal);
				resolve(1);
				return;
			}
			resolve(code ?? 1);
		});
	});
}

if (isRootCommand(args) && (args.includes("--version") || args.includes("-v"))) {
	console.log(DISPLAY_VERSION);
	process.exit();
}

if (isMissingBundledWorkspaceDependencies(getPackageDir())) {
	if (await handleBootstrapSelfUpdate(args)) {
		process.exit();
	}
}

if (requiresIsolatedProcess()) {
	process.exitCode = await spawnFullCli();
} else {
	// Entry-point process-structure seam: `cli-main` runs `main()` at module scope and owns
	// `process.exitCode` and any `process.exit()` of its own, so importing it here IS the run - there
	// is no result to forward. It has to be a dynamic import: a static one would evaluate the whole
	// engine graph before the `--version` and bootstrap-repair paths above, which answer without it.
	await import("./cli-main.ts");
}
