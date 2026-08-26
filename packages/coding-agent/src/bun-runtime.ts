/**
 * Runtime selection for a CLI that was installed with `bun install -g`.
 *
 * `bun install -g` writes `~/.bun/bin/senpi` as a symlink into
 * `<BUN_ROOT>/install/global/node_modules/...`, but the launcher still starts the script with
 * whatever interpreter resolves the shebang — Node. A user who chose Bun then silently runs on
 * Node, losing Bun's startup time and its runtime APIs. This module decides, from injected
 * facts only, whether the process should hand itself to Bun.
 *
 * Everything here is pure and injectable so the decision can be tested without touching the
 * host PATH or the real `~/.bun` tree; `cli.ts` owns the single impure call site.
 */
import { homedir as osHomedir } from "node:os";
import { posix, win32 } from "node:path";

/** Value accepted by the runtime pin environment variable. */
export type RuntimeName = "node" | "bun";

/** Environment variable that pins the runtime explicitly, bypassing detection. */
export const RUNTIME_ENV_VAR = "SENPI_RUNTIME";

/** Injected view of the world. Defaults read the real process, tests inject fakes. */
export interface BunRuntimeOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly homedir: string;
	readonly platform: NodeJS.Platform;
	readonly exists: (path: string) => boolean;
	readonly realpath: (path: string) => string;
}

/** Why the process stayed on its current runtime. Surfaced for tests and diagnostics. */
export type StayReason = "already-bun" | "runtime-pinned-node" | "inspector" | "bun-not-found" | "not-bun-install";

export type BunReexecDecision =
	| { readonly action: "stay"; readonly reason: StayReason }
	| { readonly action: "reexec"; readonly bunPath: string };

export interface BunReexecInput {
	/** Real path (symlinks resolved) of the script this process was started with. */
	readonly scriptRealPath: string;
	/** `process.versions`; a `bun` entry means this process already IS Bun. */
	readonly versions: Readonly<Record<string, string | undefined>>;
	/** Whether this process inherited a `--inspect*` option. */
	readonly hasInheritedInspectorOption: boolean;
	readonly options: BunRuntimeOptions;
}

/** Path separators differ per platform; compare on a single normalized form. */
function normalize(path: string): string {
	return path.replaceAll("\\", "/");
}

/**
 * Path semantics of the TARGET platform, not of the host running the code. Joining and PATH
 * splitting must follow the injected platform so the decision is reproducible from a Windows
 * fixture on a POSIX machine and vice versa.
 */
function paths(options: BunRuntimeOptions): typeof posix {
	return options.platform === "win32" ? win32 : posix;
}

/**
 * Root of the Bun installation: `BUN_INSTALL` when set, otherwise `~/.bun`. This is the same
 * resolution order Bun itself uses to place `bin/` and `install/global/`.
 */
function bunRoot(options: BunRuntimeOptions): string {
	const configured = options.env.BUN_INSTALL;
	if (configured !== undefined && configured.trim() !== "") {
		return configured;
	}
	return paths(options).join(options.homedir, ".bun");
}

/**
 * Resolve a directory through the injected `realpath`, falling back to the input. The bun root
 * can be a symlinked or aliased path (`/tmp` -> `/private/tmp` on macOS, a symlinked `$HOME`),
 * and the script path is compared in its resolved form, so both sides must be resolvable.
 * `realpath` throws on a path that does not exist, which simply means "no match here".
 */
function resolveOrSelf(path: string, options: BunRuntimeOptions): string {
	try {
		return options.realpath(path);
	} catch {
		return path;
	}
}

/**
 * Report whether the executed script lives inside Bun's global install tree.
 *
 * The caller must pass an already-resolved real path: `~/.bun/bin/<name>` is a symlink, and the
 * link itself is not under `install/global/`, so an unresolved path never matches. The tree root
 * is compared both as configured and as resolved, so a symlinked install root still matches.
 */
export function isUnderBunGlobalTree(scriptRealPath: string, options: BunRuntimeOptions): boolean {
	const globalRoot = paths(options).join(bunRoot(options), "install", "global");
	const script = normalize(scriptRealPath);
	for (const candidate of new Set([globalRoot, resolveOrSelf(globalRoot, options)])) {
		if (script.startsWith(`${normalize(candidate)}/`)) {
			return true;
		}
	}
	return false;
}

/** Executable name for the platform, e.g. `bun` or `bun.exe`. */
function bunExecutableName(options: BunRuntimeOptions): string {
	return options.platform === "win32" ? "bun.exe" : "bun";
}

/** Candidate file names to probe in a PATH directory, honoring `PATHEXT` on Windows. */
function pathCandidateNames(options: BunRuntimeOptions): string[] {
	if (options.platform !== "win32") {
		return ["bun"];
	}
	const pathExt = options.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	const extensions = pathExt
		.split(";")
		.map((extension) => extension.trim())
		.filter((extension) => extension.length > 0);
	return extensions.length > 0 ? extensions.map((extension) => `bun${extension}`) : ["bun.exe"];
}

/**
 * Locate a Bun binary: the configured install root first, then the default `~/.bun` root, then
 * a PATH scan. Returns `undefined` when Bun is not installed — a missing Bun is never an error,
 * the process simply stays on Node.
 */
export function findBunBinary(options: BunRuntimeOptions): string | undefined {
	const path = paths(options);
	const executable = bunExecutableName(options);
	const rootCandidates = [
		path.join(bunRoot(options), "bin", executable),
		path.join(options.homedir, ".bun", "bin", executable),
	];
	for (const candidate of rootCandidates) {
		if (options.exists(candidate)) {
			return candidate;
		}
	}

	const pathValue = options.env.PATH ?? options.env.Path;
	if (pathValue === undefined || pathValue === "") {
		return undefined;
	}
	const names = pathCandidateNames(options);
	for (const directory of pathValue.split(path.delimiter)) {
		if (directory === "") continue;
		for (const name of names) {
			const candidate = path.join(directory, name);
			if (options.exists(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

function readRuntimePin(options: BunRuntimeOptions): RuntimeName | undefined {
	const value = options.env[RUNTIME_ENV_VAR];
	if (value === "node" || value === "bun") {
		return value;
	}
	return undefined;
}

/**
 * Decide whether this process should re-exec itself under Bun. First match wins:
 *
 * 1. already running Bun — never re-exec, that would loop forever;
 * 2. `SENPI_RUNTIME=node` — an explicit opt-out always wins;
 * 3. an inherited Inspector option — a debugger session owns a Node socket, keep it;
 * 4. `SENPI_RUNTIME=bun` with Bun installed — explicit opt-in;
 * 5. the script lives in Bun's global install tree with Bun installed — the install implies it;
 * 6. otherwise stay.
 */
export function resolveBunReexec(input: BunReexecInput): BunReexecDecision {
	if (input.versions.bun !== undefined) {
		return { action: "stay", reason: "already-bun" };
	}
	const pinned = readRuntimePin(input.options);
	if (pinned === "node") {
		return { action: "stay", reason: "runtime-pinned-node" };
	}
	if (input.hasInheritedInspectorOption) {
		return { action: "stay", reason: "inspector" };
	}
	const wantsBun = pinned === "bun" || isUnderBunGlobalTree(input.scriptRealPath, input.options);
	if (!wantsBun) {
		return { action: "stay", reason: "not-bun-install" };
	}
	const bunPath = findBunBinary(input.options);
	if (bunPath === undefined) {
		return { action: "stay", reason: "bun-not-found" };
	}
	return { action: "reexec", bunPath };
}

/** Build the default, process-backed options for the real CLI entry point. */
export function processBunRuntimeOptions(
	exists: (path: string) => boolean,
	realpath: (path: string) => string,
): BunRuntimeOptions {
	return { env: process.env, homedir: osHomedir(), platform: process.platform, exists, realpath };
}
