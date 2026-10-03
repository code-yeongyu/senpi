import { spawn } from "node:child_process";

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

const DESTINATION_FLAGS = ["--target", "-t", "--prefix", "--root", "--user", "--home", "--src", "--editable", "-e"];
const STDERR_TAIL_BYTES = 4_096;

export function parsePipRequirements(text: string): string[] {
	const args = text
		.trim()
		.split(/\s+/)
		.filter((arg) => arg !== "");
	const command = args[0] === "install" ? args.slice(1) : undefined;
	if (command === undefined) {
		throw new EnvironmentError("environment_install_failed", "only `%pip install <requirements>` is supported");
	}
	if (command.length === 0) throw new EnvironmentError("environment_install_failed", "name at least one requirement");
	for (const arg of command) {
		const flag = arg.split("=")[0] ?? arg;
		const attachedShort = !arg.startsWith("--") && (arg.startsWith("-t") || arg.startsWith("-e"));
		if (DESTINATION_FLAGS.includes(flag) || attachedShort) {
			throw new EnvironmentError(
				"environment_install_failed",
				`${flag} is not allowed: packages always install into the session's environment root`,
			);
		}
	}
	return command;
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
			env: { ...process.env, PYTHONNOUSERSITE: "1", PIP_REQUIRE_VIRTUALENV: "0", PIP_USER: "0" },
		});
		let stderrTail = "";
		child.stdout.setEncoding("utf8").on("data", (data: string) => input.onOutput?.("stdout", data));
		child.stderr.setEncoding("utf8").on("data", (data: string) => {
			stderrTail = (stderrTail + data).slice(-STDERR_TAIL_BYTES);
			input.onOutput?.("stderr", data);
		});
		const onAbort = () => child.kill("SIGKILL");
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
