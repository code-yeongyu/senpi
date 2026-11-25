import { type ConfiguredPackage, DefaultPackageManager, type ProgressCallback } from "../core/package-manager.ts";
import { type EngineCommandScope, openCommandSettings, settingsDiagnostics } from "./command-settings.ts";
import { type EngineDiagnostic, type EngineResult, engineError, engineOk, errorMessage } from "./result.ts";

export interface PackageSourceInput {
	readonly source: string;
	/** Project settings (`-l`) instead of the user's. */
	readonly local?: boolean;
	/** The project-trust choice: `true` is `--approve`, `false` is `--no-approve`. */
	readonly trust?: boolean;
}

export interface PackageListInput {
	readonly trust?: boolean;
}

export interface PackageUpdateInput {
	/** One installed package; every installed package when omitted. */
	readonly source?: string;
	readonly trust?: boolean;
}

export interface PackageCommandOptions {
	/** Each step the package manager starts (`Installing <source>...`), as it starts. */
	readonly onProgress?: ProgressCallback;
}

export type PackageCommandCode = "project_untrusted" | "not_found" | "failed";

const UNKNOWN_FAILURE = "Unknown package command error";

interface OpenedPackageManager {
	readonly packageManager: DefaultPackageManager;
	readonly diagnostics: readonly EngineDiagnostic[];
}

async function openPackageManager(
	scope: EngineCommandScope,
	options: PackageCommandOptions & {
		readonly trust: boolean | undefined;
		readonly writesProjectConfig: boolean;
		readonly useSavedProjectTrustOnly: boolean;
	},
): Promise<OpenedPackageManager | EngineResult<never, PackageCommandCode>> {
	const { settingsManager, trustDiagnostics } = await openCommandSettings(scope, {
		...(options.trust === undefined ? {} : { trust: options.trust }),
		useSavedProjectTrustOnly: options.useSavedProjectTrustOnly,
	});
	if (options.writesProjectConfig && !settingsManager.isProjectTrusted()) {
		return engineError("project_untrusted", "Project is not trusted. Use --approve to modify local package config.", {
			diagnostics: trustDiagnostics,
		});
	}
	const diagnostics = [...trustDiagnostics, ...settingsDiagnostics(settingsManager, "package command")];
	const packageManager = new DefaultPackageManager({ cwd: scope.cwd, agentDir: scope.agentDir, settingsManager });
	packageManager.setProgressCallback(options.onProgress);
	return { packageManager, diagnostics };
}

async function runPackageStep<T>(
	opened: OpenedPackageManager | EngineResult<never, PackageCommandCode>,
	step: (packageManager: DefaultPackageManager) => Promise<EngineResult<T, PackageCommandCode>>,
): Promise<EngineResult<T, PackageCommandCode>> {
	if ("kind" in opened) return opened;
	try {
		const result = await step(opened.packageManager);
		return { ...result, diagnostics: opened.diagnostics };
	} catch (error: unknown) {
		return engineError("failed", errorMessage(error, UNKNOWN_FAILURE), { diagnostics: opened.diagnostics });
	}
}

export async function installPackage(
	scope: EngineCommandScope,
	input: PackageSourceInput,
	options: PackageCommandOptions = {},
): Promise<EngineResult<{ readonly source: string }, PackageCommandCode>> {
	const local = input.local === true;
	const opened = await openPackageManager(scope, {
		...options,
		trust: input.trust,
		writesProjectConfig: local,
		useSavedProjectTrustOnly: false,
	});
	return runPackageStep(opened, async (packageManager) => {
		await packageManager.installAndPersist(input.source, { local });
		return engineOk({ source: input.source });
	});
}

export async function removePackage(
	scope: EngineCommandScope,
	input: PackageSourceInput,
	options: PackageCommandOptions = {},
): Promise<EngineResult<{ readonly source: string }, PackageCommandCode>> {
	const local = input.local === true;
	const opened = await openPackageManager(scope, {
		...options,
		trust: input.trust,
		writesProjectConfig: local,
		useSavedProjectTrustOnly: false,
	});
	return runPackageStep(opened, async (packageManager) =>
		(await packageManager.removeAndPersist(input.source, { local }))
			? engineOk({ source: input.source })
			: engineError("not_found", `No matching package found for ${input.source}`),
	);
}

export async function listPackages(
	scope: EngineCommandScope,
	input: PackageListInput = {},
): Promise<EngineResult<{ readonly packages: readonly ConfiguredPackage[] }, PackageCommandCode>> {
	const opened = await openPackageManager(scope, {
		trust: input.trust,
		writesProjectConfig: false,
		useSavedProjectTrustOnly: false,
	});
	return runPackageStep(opened, async (packageManager) =>
		engineOk({ packages: packageManager.listConfiguredPackages() }),
	);
}

/** Updates one installed package, or every installed package; never the engine itself. */
export async function updatePackages(
	scope: EngineCommandScope,
	input: PackageUpdateInput = {},
	options: PackageCommandOptions = {},
): Promise<EngineResult<{ readonly source?: string }, PackageCommandCode>> {
	const opened = await openPackageManager(scope, {
		...options,
		trust: input.trust,
		writesProjectConfig: false,
		useSavedProjectTrustOnly: true,
	});
	return runPackageStep(opened, async (packageManager) => {
		await packageManager.update(input.source);
		return engineOk(input.source === undefined ? {} : { source: input.source });
	});
}
