import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { EnvironmentError } from "./py-installer.ts";

export type JsInstallerChoice = "auto" | "bun" | "npm";
export type JsInstaller = "bun" | "npm";

const STDERR_TAIL_BYTES = 4_096;

function onPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
	for (const directory of (env[pathKey] ?? "").split(delimiter)) {
		if (directory === "") continue;
		for (const extension of extensions) {
			const candidate = join(directory, `${command}${extension}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export function resolveJsInstaller(
	choice: JsInstallerChoice,
	env: NodeJS.ProcessEnv,
): { readonly installer: JsInstaller; readonly command: string } {
	const order: readonly JsInstaller[] = choice === "auto" ? ["bun", "npm"] : [choice];
	for (const installer of order) {
		const command = onPath(installer, env);
		if (command !== undefined) return { installer, command };
	}
	throw new EnvironmentError(
		"environment_installer_unavailable",
		choice === "auto" ? "neither bun nor npm is on PATH" : `${choice} is not on PATH`,
	);
}

export function parseJsPackages(text: string): string[] {
	if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(text)) {
		throw new EnvironmentError("environment_install_failed", "package names cannot contain control characters");
	}
	const packages = text.split(/\s+/).filter((token) => token !== "");
	const flag = packages.find((token) => token.startsWith("-"));
	if (flag !== undefined) {
		throw new EnvironmentError(
			"environment_install_failed",
			`installer flags are chosen by the host; name packages only (got ${flag})`,
		);
	}
	if (packages.length === 0)
		throw new EnvironmentError("environment_install_failed", "name at least one package to add");
	return packages;
}

/**
 * A path-like spec (`./pkg`, `../x.tgz`, `file:./pkg`) means a path from the session directory; both installers get it
 * absolute, because bun resolves a relative spec from the revision it builds and npm from its own cwd.
 */
export function absoluteSpec(spec: string, cwd: string): string {
	const file = spec.startsWith("file:") ? spec.slice("file:".length) : undefined;
	const path = file ?? spec;
	const pathLike = path.startsWith("./") || path.startsWith("../") || path === "." || path === "..";
	if (!pathLike) return spec;
	const absolute = resolve(cwd, path);
	return file === undefined ? absolute : `file:${absolute}`;
}

export function jsInstallArgv(installer: JsInstaller, root: string, packages: readonly string[]): string[] {
	return installer === "bun"
		? ["add", "--ignore-scripts", "--cwd", root, ...packages]
		: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", root, ...packages];
}

export function jsRemoveArgv(installer: JsInstaller, root: string, name: string): string[] {
	return installer === "bun"
		? ["remove", "--ignore-scripts", "--cwd", root, name]
		: ["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", root, name];
}

const REGISTRY_NAME = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@[^/]*)?$/i;

/**
 * The package name a spec installs, when it can be known before the install: a local directory's or tarball's own
 * `package.json` name, or the name of a registry spec (`name`, `name@range`, `@scope/name@range`). Undefined for URL
 * and git specs.
 */
export async function requestedPackageName(spec: string): Promise<string | undefined> {
	const path = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
	if (isAbsolute(path)) {
		try {
			const manifest: unknown = JSON.parse(
				(await stat(path)).isDirectory()
					? await readFile(join(path, "package.json"), "utf8")
					: await tarballManifest(path),
			);
			return typeof manifest === "object" &&
				manifest !== null &&
				"name" in manifest &&
				typeof manifest.name === "string"
				? manifest.name
				: undefined;
		} catch {
			return undefined;
		}
	}
	return REGISTRY_NAME.exec(spec)?.[1];
}

/**
 * An archive's own `package.json`, read from its single top-level directory as both installers unpack it: npm's
 * `package/`, or a GitHub-style `<repo>-<sha>/`. tar detects the compression itself, so a plain `.tar` works too.
 */
async function tarballManifest(path: string): Promise<string> {
	const entries = (await tarOutput(["-tf", path])).split("\n").filter((entry) => entry !== "");
	const normalized = (entry: string) => entry.replace(/^(\.\/)+/, "");
	const tops = new Set(entries.map((entry) => normalized(entry).split("/")[0] ?? "").filter((top) => top !== ""));
	// An archive whose entries do not all sit under one directory has no single package to name: judging it by
	// whichever entry comes first could name the wrong one.
	const [top, ...others] = [...tops];
	if (top === undefined || others.length > 0 || top === "." || top === "..") {
		throw new Error("the archive does not hold one top-level directory");
	}
	// Extract by the member's own name: GNU tar matches it exactly, so a leading "./" must be kept.
	const manifest = entries.find((entry) => normalized(entry) === `${top}/package.json`);
	if (manifest === undefined) throw new Error("the archive holds no package.json in its top-level directory");
	return await tarOutput(["-xOf", path, manifest]);
}

function tarOutput(args: readonly string[]): Promise<string> {
	return new Promise((resolveText, reject) => {
		execFile("tar", [...args], { maxBuffer: 64 << 20 }, (error, stdout) =>
			error === null ? resolveText(stdout) : reject(error),
		);
	});
}

export function runJsInstall(input: {
	readonly installer: JsInstaller;
	readonly command: string;
	readonly root: string;
	readonly packages: readonly string[];
	/** Remove this package instead of adding `packages`. */
	readonly remove?: string;
	/** Absolute specs already recorded in the revision; the installer echoes them, so they are redacted too. */
	readonly recordedSpecs?: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly signal: AbortSignal;
	readonly onOutput?: (stream: "stdout" | "stderr", data: string) => void;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		if (input.signal.aborted) {
			reject(new EnvironmentError("environment_install_cancelled", "the install was cancelled before it started"));
			return;
		}
		const argv =
			input.remove === undefined
				? jsInstallArgv(input.installer, input.root, input.packages)
				: jsRemoveArgv(input.installer, input.root, input.remove);
		const child = spawn(input.command, argv, {
			cwd: input.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// npm reads `global`/`location` from any .npmrc and the env; a global install would land where the import never looks.
			env: {
				...input.env,
				npm_config_ignore_scripts: "true",
				npm_config_global: "false",
				npm_config_location: "project",
			},
			detached: process.platform !== "win32",
		});
		let output = "";
		const record = (stream: "stdout" | "stderr") => (data: string) => {
			output = (output + data).slice(-STDERR_TAIL_BYTES);
			input.onOutput?.(stream, withoutHostPaths(data, input));
		};
		child.stdout.setEncoding("utf8").on("data", record("stdout"));
		child.stderr.setEncoding("utf8").on("data", record("stderr"));
		const onAbort = () => {
			if (child.pid !== undefined && process.platform !== "win32") {
				try {
					process.kill(-child.pid, "SIGKILL");
					return;
				} catch {
					// ESRCH (the group is gone) or EPERM (macOS refuses a group whose leader already exited): stop the
					// installer itself. An abort listener must never throw: nothing above it can catch the error.
				}
			}
			child.kill("SIGKILL");
		};
		input.signal.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			input.signal.removeEventListener("abort", onAbort);
			reject(
				new EnvironmentError(
					"environment_installer_unavailable",
					`${input.installer}: ${withoutHostPaths(error.message, input)}`,
				),
			);
		});
		child.once("close", (code, signal) => {
			input.signal.removeEventListener("abort", onAbort);
			if (input.signal.aborted) {
				reject(
					new EnvironmentError(
						"environment_install_cancelled",
						`the install was cancelled${cancelReason(input.signal, input)}; ${input.installer} was stopped`,
					),
				);
			} else if (code === 0) resolve();
			else {
				reject(
					new EnvironmentError(
						"environment_install_failed",
						withoutHostPaths(output.trim(), input) || `${input.installer} exited with ${code ?? signal}`,
					),
				);
			}
		});
	});
}

function cancelReason(signal: AbortSignal, input: Parameters<typeof withoutHostPaths>[1]): string {
	const reason: unknown = signal.reason;
	return reason instanceof Error && reason.name !== "AbortError" ? `: ${withoutHostPaths(reason.message, input)}` : "";
}

/** Installer output names the session's own roots; error text says `<root>`/`<cwd>`/`~` instead of absolute paths. */
export function withoutHostPaths(
	text: string,
	input: {
		readonly root: string;
		readonly cwd: string;
		readonly packages: readonly string[];
		readonly recordedSpecs?: readonly string[];
	},
): string {
	const home = homedir();
	// A spec that is an absolute file path names the user's file system; it is shown by its file name only.
	// This install's absolute specs, and every path an earlier install recorded (npm records a relative `file:` path).
	const requested = input.packages
		.map((spec) => (spec.startsWith("file:") ? spec.slice("file:".length) : spec))
		.filter((path) => isAbsolute(path));
	const specPaths = [...requested, ...(input.recordedSpecs ?? [])]
		.sort((a, b) => b.length - a.length)
		.map((path) => [path, `<path>/${basename(path)}`] as const);
	return [
		...specPaths,
		[input.root, "<root>"],
		[input.cwd, "<cwd>"],
		[realpathOrSelf(tmpdir()), "<tmp>"],
		[tmpdir(), "<tmp>"],
		[home, "~"],
	]
		.filter(([path]) => path !== "" && path !== sep)
		.reduce((current, [path, label]) => current.replaceAll(path, label), text);
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
