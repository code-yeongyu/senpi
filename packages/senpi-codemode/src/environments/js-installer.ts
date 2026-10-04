import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
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

export function jsInstallArgv(installer: JsInstaller, root: string, packages: readonly string[]): string[] {
	return installer === "bun"
		? ["add", "--ignore-scripts", "--cwd", root, ...packages]
		: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", root, ...packages];
}

export function runJsInstall(input: {
	readonly installer: JsInstaller;
	readonly command: string;
	readonly root: string;
	readonly packages: readonly string[];
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
		const child = spawn(input.command, jsInstallArgv(input.installer, input.root, input.packages), {
			cwd: input.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...input.env, npm_config_ignore_scripts: "true" },
			detached: process.platform !== "win32",
		});
		let output = "";
		const record = (stream: "stdout" | "stderr") => (data: string) => {
			output = (output + data).slice(-STDERR_TAIL_BYTES);
			input.onOutput?.(stream, data);
		};
		child.stdout.setEncoding("utf8").on("data", record("stdout"));
		child.stderr.setEncoding("utf8").on("data", record("stderr"));
		const onAbort = () => {
			if (child.pid !== undefined && process.platform !== "win32") {
				try {
					process.kill(-child.pid, "SIGKILL");
					return;
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
				}
			}
			child.kill("SIGKILL");
		};
		input.signal.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => {
			input.signal.removeEventListener("abort", onAbort);
			reject(new EnvironmentError("environment_installer_unavailable", `${input.installer}: ${error.message}`));
		});
		child.once("close", (code, signal) => {
			input.signal.removeEventListener("abort", onAbort);
			if (input.signal.aborted) {
				reject(
					new EnvironmentError(
						"environment_install_cancelled",
						`the install was cancelled; ${input.installer} was stopped`,
					),
				);
			} else if (code === 0) resolve();
			else {
				reject(
					new EnvironmentError(
						"environment_install_failed",
						output.trim() || `${input.installer} exited with ${code ?? signal}`,
					),
				);
			}
		});
	});
}
