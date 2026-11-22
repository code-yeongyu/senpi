/**
 * The host side of the kill guard (senpi#5349): the user switch, the host's own process view, the protected pids it
 * hands to kernels, and where a codemode worker finds the judge module in each shipped layout.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBunBinary } from "../../config.ts";
import { SettingsManager } from "../settings-manager.ts";
import { killGuardContext, spawnSyncFromNode } from "./process-view.ts";
import { minimalProtected, protectedSet } from "./protected.ts";
import type { KillGuardContext, KillGuardShell, KillGuardVantage } from "./types.ts";

export type KillGuardSetting = "on" | "off";

/** `terminal.killGuard` from USER settings only: a project cannot switch the guard off for itself. */
export function readKillGuardSetting(cwd: string, agentDir?: string): KillGuardSetting {
	const settings = agentDir === undefined ? SettingsManager.create(cwd) : SettingsManager.create(cwd, agentDir);
	return settings.getGlobalSettings().terminal?.killGuard === "off" ? "off" : "on";
}

const hostSpawnSync = spawnSyncFromNode(spawnSync);

/** A decision context for a signal the host itself will issue on the agent's behalf. */
export function hostKillGuardContext(vantage: KillGuardVantage, shell: KillGuardShell): KillGuardContext {
	return killGuardContext({
		platform: process.platform,
		agentPid: process.pid,
		agentPpid: process.ppid,
		vantage,
		shell,
		spawnSync: hostSpawnSync,
	});
}

/** The protected set P at this moment, exported to kernels as `SENPI_KILL_GUARD_PROTECTED` (their cheap prefilter). */
export function killGuardProtectedPids(): number[] {
	const context = hostKillGuardContext({ kind: "agent" }, "argv");
	const view = context.view();
	const protectedPids = view === undefined ? minimalProtected(context) : protectedSet(context, view.rows);
	return [...protectedPids.keys()].sort((a, b) => a - b);
}

/** Bun wrapper builders define the judge entry relative to their explicit --root. */
declare const SENPI_KILL_GUARD_ENTRY: string | undefined;
const compiledEntry =
	typeof SENPI_KILL_GUARD_ENTRY === "string" ? SENPI_KILL_GUARD_ENTRY : "./src/core/kill-guard/index.ts";

/**
 * The judge module a codemode worker imports by URL (amendment A8): never the `@code-yeongyu/senpi` peer specifier,
 * which a worker cannot resolve in every layout. The source tree and the unbundled `dist` keep `index` beside this
 * file; the npm bundle emits it as `kill-guard.js` beside the chunk this module lands in; the compiled binary embeds it
 * as an explicit entry under its source path.
 */
function judgeModuleUrl(): string {
	if (isBunBinary) return pathToFileURL(fileURLToPath(new URL(compiledEntry, import.meta.url))).href;
	const here = import.meta.url;
	if (/\/core\/kill-guard\/host\.(ts|js)$/.test(here))
		return new URL(here.endsWith(".ts") ? "./index.ts" : "./index.js", here).href;
	return new URL("./kill-guard.js", here).href;
}

export const KILL_GUARD_MODULE_URL: string = judgeModuleUrl();
