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
	KILL_GUARD_PROMPT_HOOK_PREFIX,
	KILL_GUARD_SHIM_MARKER,
	type KillGuardShimFiles,
	killGuardPromptCommand,
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
			writeFileSync(join(staged, name), content, { mode: name.endsWith(".sh") ? 0o644 : 0o755 });
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
 * Whether bash started with this inherited SHLVL counts as nested (level >= 2 after its own increment). A top-level
 * non-interactive bash skips BASH_ENV when its stdin is a socket (bash's rshd rule) or sshd started it, and SHLVL >= 999
 * makes bash reset the level to 1.
 */
function nestedShellLevel(level: string | undefined): boolean {
	return level !== undefined && /^[1-9]\d{0,2}$/.test(level) && Number(level) < 999;
}

/**
 * The variables that carry `runtime` into a process started with `base`: the shim directory first on PATH (once),
 * BASH_ENV on the wrapper with the user's own BASH_ENV kept in `SENPI_KILL_GUARD_USER_BASH_ENV` (also when `base`
 * already carries a kill-guard BASH_ENV from an outer agent), PROMPT_COMMAND on the hook that carries the same `kill`
 * wrapper into interactive bash with the user's own PROMPT_COMMAND kept the same way in
 * `SENPI_KILL_GUARD_USER_PROMPT_COMMAND` (an outer agent's hook is never captured as the user's: it would eval itself
 * forever), the judge exports, and `SHLVL=1` when `base` has no usable level, so bash reads BASH_ENV whatever its
 * stdin is.
 */
export function killGuardEnvironment(base: NodeJS.ProcessEnv, runtime: KillGuardRuntime): Record<string, string> {
	const pathKey = Object.keys(base).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const rest = (base[pathKey] ?? "").split(delimiter).filter((entry) => entry !== "" && entry !== runtime.dir);
	const userBashEnv = isKillGuardBashEnv(base.BASH_ENV) ? base.SENPI_KILL_GUARD_USER_BASH_ENV : base.BASH_ENV;
	const userPromptCommand = base.PROMPT_COMMAND?.startsWith(KILL_GUARD_PROMPT_HOOK_PREFIX)
		? base.SENPI_KILL_GUARD_USER_PROMPT_COMMAND
		: base.PROMPT_COMMAND;
	return {
		[pathKey]: [runtime.dir, ...rest].join(delimiter),
		BASH_ENV: runtime.bashEnv,
		SENPI_KILL_GUARD_USER_BASH_ENV: userBashEnv ?? "",
		PROMPT_COMMAND: killGuardPromptCommand(runtime.dir),
		SENPI_KILL_GUARD_USER_PROMPT_COMMAND: userPromptCommand ?? "",
		SENPI_KILL_GUARD_PROTECTED: runtime.protectedPids.join(","),
		SENPI_KILL_GUARD_EXEC: runtime.exec,
		SENPI_KILL_GUARD_EXEC_ENTRY: runtime.entry ?? "",
		SENPI_KILL_GUARD_AGENT_PID: String(runtime.agentPid),
		...(nestedShellLevel(base.SHLVL) ? {} : { SHLVL: "1" }),
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
/** Each holder's runtime, in activation order: the most recently activated remaining holder's runtime is active. */
const holders = new Map<object, KillGuardRuntime>();

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
	holders.delete(options.holder);
	holders.set(options.holder, runtime);
	return runtime;
}

/**
 * Drops one holder (its session ended, or its user switched the guard off); the other holders keep theirs, and the
 * runtime layer stops reaching new processes once none is left.
 */
export function releaseKillGuardRuntime(holder: object): void {
	holders.delete(holder);
}

export function activeKillGuardRuntime(): KillGuardRuntime | undefined {
	let active: KillGuardRuntime | undefined;
	for (const runtime of holders.values()) active = runtime;
	return active;
}

export function withKillGuardRuntime(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const active = activeKillGuardRuntime();
	return active === undefined ? env : { ...env, ...killGuardEnvironment(env, active) };
}

/** The runtime layer's variables for a kernel session environment built on `base`; empty when none is active. */
export function activeKillGuardEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
	const active = activeKillGuardRuntime();
	return active === undefined ? {} : killGuardEnvironment(base, active);
}
