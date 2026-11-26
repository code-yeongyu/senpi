import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { type ExtensionContext, getShellConfig, SettingsManager, withBundledBunCommands } from "@code-yeongyu/senpi";

export interface KernelPathEnvOptions {
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	/** The `shellPath` setting the bash tool passes to `getShellConfig`. */
	readonly shellPath?: string | undefined;
	/** Resolves the bash the bash tool would use; undefined when there is none. */
	readonly resolveBash?: (shellPath: string | undefined) => string | undefined;
	readonly isFile?: (path: string) => boolean;
	readonly withBundledBun?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

/**
 * The `shellPath` the session's bash tool reads: this session's agent dir, and project settings only when the project
 * is trusted, so eval and bash resolve the same shell.
 */
export function sessionShellPath(
	ctx: Pick<ExtensionContext, "cwd" | "agentDir" | "isProjectTrusted">,
): string | undefined {
	return SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() }).getShellPath();
}

/** Names the bash tool's shell to the Python kernel on win32, so `%%bash` and a bare `bash`/`sh` run exactly it. */
export const KERNEL_BASH_ENV = "SENPI_KERNEL_BASH";

/**
 * Shell environment for every kernel child, or an empty record when the inherited one is already right.
 * Carries the bundled `bun` directory the bash tool's PATH has (omo#9362). On win32 it also names the bash the
 * bash tool runs (`KERNEL_BASH_ENV`) and puts that bash's Git `bin` directory first on PATH.
 */
export function kernelShellEnv(options: KernelPathEnvOptions = {}): Record<string, string> {
	const base = options.env ?? process.env;
	const withBun = (options.withBundledBun ?? withBundledBunCommands)(base);
	const win32 = (options.platform ?? process.platform) === "win32";
	const resolved = win32 ? (options.resolveBash ?? resolveBashFromShellConfig)(options.shellPath) : undefined;
	const bash = resolved === undefined || isWslLauncher(resolved) ? undefined : resolved;
	const env = win32 ? withGitBashFirst(withBun, bash, options.isFile ?? existsSync) : withBun;
	const pathKey = pathKeyOf(env);
	const value = env[pathKey];
	return {
		...(env === base || value === undefined ? {} : { [pathKey]: value }),
		...(bash === undefined ? {} : { [KERNEL_BASH_ENV]: bash }),
	};
}

// A bare `bash` in a cell resolves through the kernel's PATH, where a default Git for Windows install
// lists only Git\cmd, so System32\bash.exe (the WSL launcher) won and booted WSL (omo#10894). The kernel
// gets the directory of the bash the bash tool runs, so `bash` and `sh` resolve to Git Bash first. Only a
// Git-style `bin` directory qualifies: a usr\bin with coreutils would shadow System32's find/sort/timeout
// for every kernel child, so any other bash leaves PATH alone.
function withGitBashFirst(
	env: NodeJS.ProcessEnv,
	bash: string | undefined,
	isFile: (path: string) => boolean,
): NodeJS.ProcessEnv {
	if (bash === undefined) return env;
	const dir = win32.dirname(bash);
	if (!isGitBashBinDir(dir, isFile)) return env;
	const pathKey = pathKeyOf(env);
	const rest = (env[pathKey] ?? "")
		.split(win32.delimiter)
		.filter((entry) => entry !== "" && sameDir(entry, dir) === false);
	return { ...env, [pathKey]: [dir, ...rest].join(win32.delimiter) };
}

const SHELLS = ["bash.exe", "sh.exe"] as const;
const SYSTEM32_TOOLS = ["find.exe", "sort.exe", "timeout.exe"] as const;

function isGitBashBinDir(dir: string, isFile: (path: string) => boolean): boolean {
	const file = (name: string) => isFile(`${dir}${dir.includes("/") && !dir.includes("\\") ? "/" : "\\"}${name}`);
	return SHELLS.every(file) && !SYSTEM32_TOOLS.some(file);
}

function resolveBashFromShellConfig(shellPath: string | undefined): string | undefined {
	try {
		const config = getShellConfig(shellPath);
		return config.kind === "bash" || config.kind === "sh" ? config.shell : undefined;
	} catch {
		// getShellConfig throws when no bash exists (or a configured path is missing); the bash tool
		// reports that itself, and the kernel keeps the inherited PATH.
		return undefined;
	}
}

function isWslLauncher(path: string): boolean {
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(path.replace(/\//g, "\\"));
}

function sameDir(a: string, b: string): boolean {
	const normalize = (dir: string) => win32.normalize(dir).replace(/\\+$/, "").toLowerCase();
	return normalize(a) === normalize(b);
}

function pathKeyOf(env: NodeJS.ProcessEnv): string {
	return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}
