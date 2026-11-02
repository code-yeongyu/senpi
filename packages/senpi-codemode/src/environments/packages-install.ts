import type { JsEnvironments, JsInstallReceipt } from "./js-environments.ts";
import type { InstallReceipt } from "./py-environment.ts";
import { EnvironmentError } from "./py-installer.ts";
import type { PythonEnvironments } from "./python-environments.ts";

export interface PackagesInstallEnvironments {
	readonly python?: PythonEnvironments;
	readonly js?: JsEnvironments;
}

export const PACKAGES_INSTALL_DEFAULT_TIMEOUT_SECONDS = 600;

interface PackagesInstallRequest {
	readonly manager: "pip" | "bun" | "npm";
	readonly requirements: readonly string[];
	readonly timeoutSeconds: number;
}

function invalid(message: string): EnvironmentError {
	return new EnvironmentError("environment_install_failed", `packages.install(): ${message}`);
}

function parseRequest(args: unknown): PackagesInstallRequest {
	if (typeof args !== "object" || args === null) throw invalid("expected (manager, requirements, {timeout?})");
	const manager = "manager" in args ? args.manager : undefined;
	if (manager !== "pip" && manager !== "bun" && manager !== "npm") {
		throw invalid('manager must be "pip" (Python) or "bun" / "npm" (JavaScript)');
	}
	const raw = "requirements" in args ? args.requirements : undefined;
	const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined;
	if (
		list === undefined ||
		list.length === 0 ||
		!list.every((item) => typeof item === "string" && item.trim() !== "")
	) {
		throw invalid("requirements must be a non-empty string or a non-empty list of non-empty strings");
	}
	const timeout = "timeout" in args ? args.timeout : undefined;
	if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
		throw invalid("timeout must be a positive number of seconds");
	}
	return {
		manager,
		requirements: list.map((item: string) => item.trim()),
		timeoutSeconds: timeout ?? PACKAGES_INSTALL_DEFAULT_TIMEOUT_SECONDS,
	};
}

function jsArguments(requirements: readonly string[]): string {
	for (const requirement of requirements) {
		if (/\s/.test(requirement)) throw invalid(`a package spec cannot contain whitespace: ${requirement}`);
	}
	return requirements.join(" ");
}

/**
 * `packages.install(manager, requirements, {timeout?})`: the in-cell form of `%pip install` / `%bun add` /
 * `%npm add`. It drives the same session environment the magic cells use and returns its receipt; a stop of the
 * owning cell cancels it (environment_install_cancelled), and the timeout fails it with environment_install_timeout.
 * pip receives the requirement list as separate arguments, never re-split. The installer's output is not streamed
 * into the cell: the receipt is the result, and a failure carries the installer's stderr tail.
 */
export async function runPackagesInstall(
	args: unknown,
	environments: PackagesInstallEnvironments,
	signal: AbortSignal | undefined,
): Promise<InstallReceipt | JsInstallReceipt> {
	const request = parseRequest(args);
	const { python, js } = environments;
	const manager = request.manager;
	let install: ((signal: AbortSignal) => Promise<InstallReceipt | JsInstallReceipt>) | undefined;
	if (manager === "pip") {
		if (python !== undefined) install = (signal) => python.install(request.requirements, signal);
	} else if (js !== undefined) {
		install = (signal) => js.install(jsArguments(request.requirements), signal, undefined, manager);
	}
	if (install === undefined) {
		throw new EnvironmentError(
			"environment_installer_unavailable",
			manager === "pip"
				? "pip installs need this session to have a Python interpreter"
				: "bun/npm installs run only in a JavaScript cell",
		);
	}
	const timeout = AbortSignal.timeout(request.timeoutSeconds * 1_000);
	const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
	try {
		return await install(combined);
	} catch (error) {
		if (timeout.aborted && !(signal?.aborted ?? false)) {
			throw new EnvironmentError(
				"environment_install_timeout",
				`the install did not finish within ${request.timeoutSeconds}s and was stopped`,
			);
		}
		throw error;
	}
}
