import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import {
	type EnvironmentMode,
	type InstallReceipt,
	installPythonPackages,
	managedEnvironmentBase,
	projectPythonBase,
	pythonAbiTag,
} from "./py-environment.ts";
import { EnvironmentError } from "./py-installer.ts";
import { readActiveRevisionSync } from "./revision-store.ts";

export interface PythonEnvironmentsOptions {
	readonly artifactsDir: string;
	readonly cwd: string;
	readonly interpreter: string;
	readonly settings: Pick<ResolvedCodemodeSettings, "environments">;
}

export class PythonEnvironments {
	readonly #options: PythonEnvironmentsOptions;
	#mode: EnvironmentMode = "managed";
	#currentBase: string | undefined;
	#managedBase: Promise<string> | undefined;

	constructor(options: PythonEnvironmentsOptions) {
		this.#options = options;
	}

	get mode(): EnvironmentMode {
		return this.#mode;
	}

	/**
	 * The revision a Python cell imports from, read from the current mode's root each time a cell starts, so an
	 * install by another session sharing the project root is seen. Undefined while nothing is installed there.
	 */
	get activeRoot(): string | undefined {
		return this.#currentBase === undefined ? undefined : readActiveRevisionSync(this.#currentBase)?.dir;
	}

	async setMode(mode: EnvironmentMode): Promise<string> {
		const base = await this.#base(mode);
		this.#mode = mode;
		this.#currentBase = base;
		return base;
	}

	async install(
		requirements: string | readonly string[],
		signal: AbortSignal,
		onOutput?: (stream: "stdout" | "stderr", data: string) => void,
	): Promise<InstallReceipt> {
		if (this.#options.settings.environments?.autoProvision === false) {
			throw new EnvironmentError(
				"environment_installer_unavailable",
				"installs are turned off for this project (environments.autoProvision is false)",
			);
		}
		const mode = this.#mode;
		const base = await this.#base(mode);
		const receipt = await installPythonPackages({
			base,
			mode,
			interpreter: this.#options.interpreter,
			requirements,
			cwd: this.#options.cwd,
			signal,
			...(onOutput === undefined ? {} : { onOutput }),
		});
		if (this.#mode === mode) this.#currentBase = base;
		return receipt;
	}

	#base(mode: EnvironmentMode): Promise<string> {
		if (mode === "project") return Promise.resolve(projectPythonBase(this.#options.cwd));
		const configured = this.#options.settings.environments?.managedRoot;
		this.#managedBase ??= pythonAbiTag(this.#options.interpreter).then((abi) =>
			configured === undefined
				? managedEnvironmentBase(this.#options.artifactsDir, "py", abi)
				: managedEnvironmentBase(configured, "py", abi),
		);
		return this.#managedBase;
	}
}
