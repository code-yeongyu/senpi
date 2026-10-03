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
import { readActiveRevision } from "./revision-store.ts";

export interface PythonEnvironmentsOptions {
	readonly artifactsDir: string;
	readonly cwd: string;
	readonly interpreter: string;
	readonly settings: Pick<ResolvedCodemodeSettings, "environments">;
}

export class PythonEnvironments {
	readonly #options: PythonEnvironmentsOptions;
	#mode: EnvironmentMode = "managed";
	#activeRoot: string | undefined;
	#managedBase: Promise<string> | undefined;

	constructor(options: PythonEnvironmentsOptions) {
		this.#options = options;
	}

	get mode(): EnvironmentMode {
		return this.#mode;
	}

	/** The revision the next Python cell imports from; undefined until something was installed in this mode. */
	get activeRoot(): string | undefined {
		return this.#activeRoot;
	}

	async setMode(mode: EnvironmentMode): Promise<string> {
		const base = await this.#base(mode);
		this.#mode = mode;
		this.#activeRoot = (await readActiveRevision(base))?.dir;
		return base;
	}

	async install(
		requirements: string,
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
		const receipt = await installPythonPackages({
			base: await this.#base(mode),
			mode,
			interpreter: this.#options.interpreter,
			requirements,
			cwd: this.#options.cwd,
			signal,
			...(onOutput === undefined ? {} : { onOutput }),
		});
		this.#activeRoot = receipt.root;
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
