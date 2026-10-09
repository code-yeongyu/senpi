import { spawn } from "node:child_process";
import { devNull } from "node:os";
import { terminateProcessTrees } from "../kernels/js/process-tree-host.ts";

export type EnvironmentErrorCode =
	| "environment_install_failed"
	| "environment_install_timeout"
	| "environment_install_cancelled"
	| "environment_installer_unavailable"
	| "environment_resolution_conflict"
	| "environment_language_mismatch";

export class EnvironmentError extends Error {
	readonly name = "EnvironmentError";
	readonly code: EnvironmentErrorCode;

	constructor(code: EnvironmentErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

// pip accepts any unambiguous prefix of a long option and grouped short flags, so a denylist of destination
// options can't be complete. Only these options are accepted, each spelled out in full.
const ALLOWED_FLAGS = new Set([
	"--upgrade",
	"--no-deps",
	"--pre",
	"--force-reinstall",
	"--no-index",
	"--no-cache-dir",
	"--only-binary",
	"--no-binary",
	"--prefer-binary",
	"--index-url",
	"--extra-index-url",
	"--find-links",
	"--constraint",
	"--requirement",
	"--quiet",
	"--verbose",
]);
const FLAGS_WITH_VALUE = new Set([
	"--only-binary",
	"--no-binary",
	"--index-url",
	"--extra-index-url",
	"--find-links",
	"--constraint",
	"--requirement",
]);
const SHORT_ALIASES: Readonly<Record<string, string>> = {
	"-U": "--upgrade",
	"-i": "--index-url",
	"-f": "--find-links",
	"-c": "--constraint",
	"-r": "--requirement",
	"-q": "--quiet",
	"-v": "--verbose",
};
const STDERR_TAIL_BYTES = 4_096;
const PIP_TREE_GRACE_MS = 2_000;

/**
 * Splits a %pip argument line the way the platform's shell would for these inputs: single and double quotes
 * group (`"pkg[extra]>=1.0"`) and `#` at the start of a word begins a comment. A backslash escapes the next
 * character only in POSIX mode; on Windows it is a path separator and stays as written. An unclosed quote is
 * refused rather than guessed.
 */
const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(['"', "\\", "$", "`"]);

export function splitShellWords(text: string, posix = process.platform !== "win32"): string[] {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] ?? "";
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
			continue;
		}
		if (posix && char === "\\" && index + 1 < text.length) {
			const next = text[index + 1] ?? "";
			// A backslash-newline is a line continuation in a shell, inside double quotes or not: both characters go.
			if (next === "\n") {
				index += 1;
				continue;
			}
			// Inside double quotes a shell only escapes these; any other backslash stays as written.
			if (quote === '"' && !DOUBLE_QUOTE_ESCAPES.has(next)) {
				word += char;
				continue;
			}
			index += 1;
			word += next;
			inWord = true;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
			continue;
		}
		if (/\s/u.test(char)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
			continue;
		}
		if (char === "#" && !inWord) break;
		word += char;
		inWord = true;
	}
	if (quote !== undefined)
		throw new EnvironmentError("environment_install_failed", `unclosed ${quote} quote in %pip arguments`);
	if (inWord) words.push(word);
	return words;
}

export function parsePipRequirements(text: string): string[] {
	return normalizePipInstall(splitShellWords(text));
}

/** `%pip` words already split (`["install", ...]`): `packages.install()` passes its list as-is, so nothing is re-quoted. */
export function normalizePipInstall(args: readonly string[]): string[] {
	const command = args[0] === "install" ? args.slice(1) : undefined;
	if (command === undefined) {
		throw new EnvironmentError("environment_install_failed", "only `%pip install <requirements>` is supported");
	}
	if (command.length === 0) throw new EnvironmentError("environment_install_failed", "name at least one requirement");
	const normalized: string[] = [];
	for (let index = 0; index < command.length; index++) {
		const arg = command[index] ?? "";
		if (!arg.startsWith("-")) {
			normalized.push(arg);
			continue;
		}
		const [spelled = arg, attached] = arg.split(/=(.*)/su, 2);
		const flag = SHORT_ALIASES[spelled] ?? spelled;
		if (!ALLOWED_FLAGS.has(flag)) {
			throw new EnvironmentError(
				"environment_install_failed",
				`${spelled} is not allowed: %pip accepts ${[...ALLOWED_FLAGS].join(", ")} (each spelled out in full); packages always install into the session's environment root`,
			);
		}
		if (!FLAGS_WITH_VALUE.has(flag)) {
			if (attached !== undefined)
				throw new EnvironmentError("environment_install_failed", `${spelled} takes no value`);
			normalized.push(flag);
			continue;
		}
		const value = attached ?? command[++index];
		if (value === undefined || value === "" || value.startsWith("-")) {
			throw new EnvironmentError("environment_install_failed", `${spelled} needs a value`);
		}
		normalized.push(`${flag}=${value}`);
	}
	const named = normalized.some((arg) => !arg.startsWith("-") || arg.startsWith("--requirement="));
	if (!named) throw new EnvironmentError("environment_install_failed", "name at least one requirement");
	return normalized;
}

/**
 * pip's environment with every PIP_* variable removed and its config file pointed at nothing: `--isolated`
 * alone still honours PIP_CONFIG_FILE, and a configured target, root or prefix would install outside the revision.
 */
export function isolatedPipEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.toUpperCase().startsWith("PIP_")) env[key] = value;
	}
	// pip skips every config file when PIP_CONFIG_FILE equals Python's os.devnull: "nul" on Windows, not Node's "\\\\.\\nul".
	return { ...env, PIP_CONFIG_FILE: process.platform === "win32" ? "nul" : devNull, PYTHONNOUSERSITE: "1" };
}

export function runPipInstall(input: {
	readonly interpreter: string;
	readonly root: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly onOutput?: (stream: "stdout" | "stderr", data: string) => void;
}): Promise<void> {
	const argv = [
		"-m",
		"pip",
		"install",
		// Ignore pip's config files and PIP_* variables: a configured `root` or `prefix` would write outside the revision.
		"--isolated",
		"--disable-pip-version-check",
		"--no-input",
		"--target",
		input.root,
		...input.args,
	];
	return new Promise((resolve, reject) => {
		if (input.signal.aborted) {
			reject(new EnvironmentError("environment_install_cancelled", "the install was cancelled before it started"));
			return;
		}
		const child = spawn(input.interpreter, argv, {
			cwd: input.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: isolatedPipEnv(),
		});
		let stderrTail = "";
		child.stdout.setEncoding("utf8").on("data", (data: string) => input.onOutput?.("stdout", data));
		child.stderr.setEncoding("utf8").on("data", (data: string) => {
			stderrTail = (stderrTail + data).slice(-STDERR_TAIL_BYTES);
			input.onOutput?.("stderr", data);
		});
		// pip's build backends run in their own subprocesses; stopping only pip would leave them writing.
		const onAbort = () => {
			const pid = child.pid;
			if (pid === undefined) child.kill("SIGKILL");
			else void terminateProcessTrees([pid], { graceMs: PIP_TREE_GRACE_MS }).catch(() => child.kill("SIGKILL"));
		};
		input.signal.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			input.signal.removeEventListener("abort", onAbort);
			reject(
				new EnvironmentError("environment_installer_unavailable", `${input.interpreter} -m pip: ${error.message}`),
			);
		});
		child.once("close", (code, signal) => {
			input.signal.removeEventListener("abort", onAbort);
			if (input.signal.aborted) {
				reject(new EnvironmentError("environment_install_cancelled", "the install was cancelled; pip was stopped"));
			} else if (code === 0) resolve();
			else if (/No module named pip/.test(stderrTail)) {
				reject(new EnvironmentError("environment_installer_unavailable", `${input.interpreter} has no pip module`));
			} else if (/ResolutionImpossible|conflicting dependencies/.test(stderrTail)) {
				reject(new EnvironmentError("environment_resolution_conflict", stderrTail.trim()));
			} else {
				reject(
					new EnvironmentError(
						"environment_install_failed",
						stderrTail.trim() || `pip exited with ${code ?? signal}`,
					),
				);
			}
		});
	});
}
