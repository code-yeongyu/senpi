/**
 * The kill guard's runtime layer (senpi#5349, DESIGN-12096 §4' L2): a shim directory
 * `<agent dir>/kill-guard/<version>/` written once per version, and the environment that puts it first on PATH, points
 * BASH_ENV at its wrapper and exports what the shims need. The host activates it at session start (the `kill-guard`
 * builtin) and `getShellEnv()` plus the eval kernels' session environment carry it to every agent-spawned process.
 * POSIX only: on Windows nothing is installed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary, VERSION } from "../../config.ts";
import {
	KILL_GUARD_BASH_ENV,
	KILL_GUARD_JUDGE_DEADLINE_SECONDS,
	KILL_GUARD_SHIM_MARKER,
	type KillGuardShimFiles,
	renderKillGuardShims,
} from "./shim-script.ts";

export { KILL_GUARD_SHIM_MARKER, renderKillGuardShims } from "./shim-script.ts";

export interface KillGuardRuntime {
	readonly dir: string;
	readonly bashEnv: string;
	/** The executable the shims run the judge with: the compiled binary, or the JS runtime for `entry`. */
	readonly exec: string;
	/** The judge entry script for an npm or source install; absent for the compiled binary's hidden subcommand. */
	readonly entry: string | undefined;
	readonly agentPid: number;
	readonly protectedPids: readonly number[];
}

/**
 * Writes the shim directory for `version` under `root` when it is missing or stale: staged in a temp directory and
 * renamed into place, so a reader sees either no directory or a complete one. Returns the directory.
 */
export function installKillGuardShims(
	root: string,
	version: string,
	options: { readonly deadlineSeconds?: number } = {},
): string {
	const dir = join(root, version.replace(/[^A-Za-z0-9._-]/g, "_"));
	const files = renderKillGuardShims(dir, options.deadlineSeconds ?? KILL_GUARD_JUDGE_DEADLINE_SECONDS);
	if (matches(dir, files)) return dir;
	mkdirSync(root, { recursive: true });
	const staged = mkdtempSync(join(root, ".staging-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(staged, name), content, { mode: name === KILL_GUARD_BASH_ENV ? 0o644 : 0o755 });
		}
		writeFileSync(join(staged, KILL_GUARD_SHIM_MARKER), "");
		place(staged, dir, files);
	} finally {
		rmSync(staged, { recursive: true, force: true });
	}
	return dir;
}

function matches(dir: string, files: KillGuardShimFiles): boolean {
	if (!existsSync(join(dir, KILL_GUARD_SHIM_MARKER))) return false;
	return Object.entries(files).every(([name, content]) => {
		try {
			return readFileSync(join(dir, name), "utf8") === content;
		} catch {
			return false;
		}
	});
}

/** Renames the staged directory into place; a same-version directory with stale content is swapped out first. */
function place(staged: string, dir: string, files: KillGuardShimFiles): void {
	try {
		renameSync(staged, dir);
		return;
	} catch (error) {
		if (matches(dir, files)) return;
		if (!existsSync(dir)) throw error;
	}
	const stale = mkdtempSync(join(dirname(dir), ".stale-"));
	rmSync(stale, { recursive: true, force: true });
	renameSync(dir, stale);
	try {
		renameSync(staged, dir);
	} finally {
		rmSync(stale, { recursive: true, force: true });
	}
}

function isKillGuardBashEnv(path: string | undefined): boolean {
	return (
		path !== undefined &&
		basename(path) === KILL_GUARD_BASH_ENV &&
		existsSync(join(dirname(path), KILL_GUARD_SHIM_MARKER))
	);
}

/**
 * The variables that carry `runtime` into a process started with `base`: the shim directory first on PATH (once),
 * BASH_ENV on the wrapper with the user's own BASH_ENV kept in `SENPI_KILL_GUARD_USER_BASH_ENV` (also when `base`
 * already carries a kill-guard BASH_ENV from an outer agent), and the judge exports.
 */
export function killGuardEnvironment(base: NodeJS.ProcessEnv, runtime: KillGuardRuntime): Record<string, string> {
	const pathKey = Object.keys(base).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const rest = (base[pathKey] ?? "").split(delimiter).filter((entry) => entry !== "" && entry !== runtime.dir);
	const userBashEnv = isKillGuardBashEnv(base.BASH_ENV) ? base.SENPI_KILL_GUARD_USER_BASH_ENV : base.BASH_ENV;
	return {
		[pathKey]: [runtime.dir, ...rest].join(delimiter),
		BASH_ENV: runtime.bashEnv,
		SENPI_KILL_GUARD_USER_BASH_ENV: userBashEnv ?? "",
		SENPI_KILL_GUARD_PROTECTED: runtime.protectedPids.join(","),
		SENPI_KILL_GUARD_EXEC: runtime.exec,
		SENPI_KILL_GUARD_EXEC_ENTRY: runtime.entry ?? "",
		SENPI_KILL_GUARD_AGENT_PID: String(runtime.agentPid),
	};
}

/**
 * The judge entry for this layout: none in the compiled binary (the shims call its hidden `__kill-guard` subcommand);
 * `check-entry` beside this file in the source tree and the unbundled `dist`; `kill-guard-check.js` beside the chunk
 * this module lands in for the npm bundle (the bundle build checks that they share a directory).
 */
function judgeEntry(): string | undefined {
	if (isBunBinary) return undefined;
	const here = import.meta.url;
	if (/\/core\/kill-guard\/runtime\.(ts|js)$/.test(here)) {
		return fileURLToPath(new URL(here.endsWith(".ts") ? "./check-entry.ts" : "./check-entry.js", here));
	}
	return fileURLToPath(new URL("./kill-guard-check.js", here));
}

const installed = new Map<string, KillGuardRuntime>();
const holders = new Set<object>();
let active: KillGuardRuntime | undefined;

export interface ActivateKillGuardRuntimeOptions {
	/** Whoever keeps the runtime active (one per session); the runtime stays active until every holder releases. */
	readonly holder: object;
	readonly agentDir: string;
	/** Read once per process: the protected set does not change while the agent runs. */
	readonly protectedPids: () => readonly number[];
	readonly platform?: NodeJS.Platform;
}

/** Installs (once per agent dir) and activates the runtime layer for this process; `undefined` on Windows. */
export function activateKillGuardRuntime(options: ActivateKillGuardRuntimeOptions): KillGuardRuntime | undefined {
	if ((options.platform ?? process.platform) === "win32") return undefined;
	let runtime = installed.get(options.agentDir);
	if (runtime === undefined) {
		const dir = installKillGuardShims(join(options.agentDir, "kill-guard"), VERSION);
		runtime = {
			dir,
			bashEnv: join(dir, KILL_GUARD_BASH_ENV),
			exec: process.execPath,
			entry: judgeEntry(),
			agentPid: process.pid,
			protectedPids: [...installed.values()][0]?.protectedPids ?? options.protectedPids(),
		};
		installed.set(options.agentDir, runtime);
	}
	holders.add(options.holder);
	active = runtime;
	return runtime;
}

/** Drops one holder; the runtime layer stops reaching new processes once none is left. */
export function releaseKillGuardRuntime(holder: object): void {
	holders.delete(holder);
	if (holders.size === 0) active = undefined;
}

/** The user switched the guard off: no new process gets the runtime layer, whoever held it. */
export function deactivateKillGuardRuntime(): void {
	holders.clear();
	active = undefined;
}

export function activeKillGuardRuntime(): KillGuardRuntime | undefined {
	return active;
}

export function withKillGuardRuntime(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return active === undefined ? env : { ...env, ...killGuardEnvironment(env, active) };
}

/** The runtime layer's variables for a kernel session environment built on `base`; empty when none is active. */
export function activeKillGuardEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
	return active === undefined ? {} : killGuardEnvironment(base, active);
}
