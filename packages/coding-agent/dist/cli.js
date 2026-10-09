#!/usr/bin/env node
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import "./valid-cwd.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processBunRuntimeOptions, resolveBunReexec } from "./bun-runtime.js";
import { captureStdout, exitAfterOutput, printThenExit } from "./cli/print-then-exit.js";
import { enableStartupCompileCache } from "./compile-cache.js";
import { APP_NAME, DISPLAY_VERSION, findNodePackageDir, getAgentDir, getInstallPackageDir, isBundledNode, } from "./config.js";
import { hasInheritedInspectorOption, releaseInheritedInspectorForChild } from "./inspector-policy.js";
import { prepareRuntimeSnapshot } from "./runtime-snapshot/enter.js";
import { handleBootstrapSelfUpdate } from "./self-update-bootstrap.js";
// Upstream's `cli/setup.ts` helper is deliberately not used here: this launcher only decides the
// runtime and process structure, and `cli-main.ts` performs the equivalent process/title/env/http
// setup for both entry paths (Node launcher and the Bun binary).
/**
 * Hand a Bun-installed CLI to Bun before anything else runs.
 *
 * `bun install -g` links this script into `~/.bun/bin`, but the shebang still starts it on Node,
 * so a user who chose Bun silently gets the Node runtime. Re-exec through the Bun binary when the
 * script really lives in Bun's global tree (or `SENPI_RUNTIME=bun` asks for it). This runs before
 * `enableStartupCompileCache()` on purpose: a re-exec must not pay for Node's compile-cache setup.
 * Node `execArgv` is deliberately dropped — those flags belong to the Node process, not to Bun.
 */
function reexecUnderBunIfNeeded() {
    const options = processBunRuntimeOptions(existsSync, realpathSync);
    let scriptRealPath = process.argv[1] ?? fileURLToPath(import.meta.url);
    try {
        // `~/.bun/bin/<name>` is a symlink into the global tree, so the link target is what has
        // to be classified and re-executed. A path that cannot be resolved is simply used as-is;
        // runtime selection must never be the reason startup fails.
        scriptRealPath = realpathSync(scriptRealPath);
    }
    catch { }
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
process.emitWarning = (() => { });
const args = process.argv.slice(2);
const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);
function isRootCommand(args) {
    const firstArg = args[0];
    return firstArg === undefined || !PACKAGE_COMMANDS.has(firstArg);
}
function isPackageManagerInstall(packageDir) {
    return packageDir.replace(/\\/g, "/").includes("/node_modules/@code-yeongyu/senpi");
}
function isMissingBundledWorkspaceDependencies(packageDir) {
    if (!isPackageManagerInstall(packageDir)) {
        return false;
    }
    const bundledPackages = ["pi-agent-core", "pi-ai", "pi-tui"];
    return bundledPackages.some((name) => {
        return !existsSync(join(packageDir, "node_modules", "@earendil-works", name, "dist", "index.js"));
    });
}
/** Marks the child a bundled entry spawned for its exec arguments, so it never spawns again. */
const ISOLATED_CHILD_ENV = "SENPI_CLI_ISOLATED_CHILD";
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
function requiresIsolatedProcess() {
    // The bundled entry re-executes itself rather than a sibling, so the child would otherwise see the
    // same exec arguments and spawn again forever. The marker is read before anything else runs.
    if (process.env[ISOLATED_CHILD_ENV] === "1")
        return false;
    return process.execArgv.length > 0 || hasInheritedInspectorOption();
}
async function spawnFullCli() {
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    // The bundle inlines `cli-main`, so no sibling module exists next to it: resolving one produced
    // `Module not found .../dist/bundle/cli-main.js` for every launch carrying exec arguments. The
    // bundled entry therefore replays the arguments onto a copy of itself, marked so the child loads
    // the agent in process. An unbundled install keeps spawning its sibling exactly as before.
    const fullCliPath = isBundledNode
        ? fileURLToPath(import.meta.url)
        : fileURLToPath(new URL(`./cli-main${extension}`, import.meta.url));
    releaseInheritedInspectorForChild();
    const childEnvironment = isBundledNode ? { ...process.env, [ISOLATED_CHILD_ENV]: "1" } : process.env;
    return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...process.execArgv, fullCliPath, ...args], {
            env: childEnvironment,
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
    await printThenExit(() => console.log(DISPLAY_VERSION));
}
// Help is static text plus the flags extensions registered, so a launch that already knows those
// flags must not import the engine graph to print them. The import stays dynamic for the same
// reason `cli-main` is: a static one would evaluate that graph before this answer.
if (isRootCommand(args) && args.some((arg) => arg === "--help" || arg === "-h")) {
    const { tryPrintHelpWithoutEngine } = await import("./cli/help-fast-path.js");
    const help = await captureStdout(() => tryPrintHelpWithoutEngine(args));
    if (help.result) {
        await exitAfterOutput(help.output);
    }
    process.stdout.write(help.output);
}
if (isMissingBundledWorkspaceDependencies(getInstallPackageDir())) {
    if (await handleBootstrapSelfUpdate(args)) {
        process.exit();
    }
}
if (requiresIsolatedProcess()) {
    process.exitCode = await spawnFullCli();
}
else {
    // Entry-point process-structure seam: `cli-main` runs `main()` at module scope and owns
    // `process.exitCode` and any `process.exit()` of its own, so importing it here IS the run - there
    // is no result to forward. It has to be a dynamic import: a static one would evaluate the whole
    // engine graph before the `--version` and bootstrap-repair paths above, which answer without it.
    // A bundled install hands the run to its runtime snapshot's own copy of this entry instead, so
    // an upgrade that rewrites the install cannot remove chunks this session imports later (#2358).
    const entryPath = fileURLToPath(import.meta.url);
    const snapshot = isBundledNode
        ? await prepareRuntimeSnapshot(entryPath, findNodePackageDir(dirname(entryPath)), getAgentDir())
        : undefined;
    if (snapshot?.kind === "hand-off") {
        await import(__rewriteRelativeImportExtension(snapshot.entryUrl));
    }
    else {
        await import("./cli-main.js");
    }
}
//# sourceMappingURL=cli.js.map