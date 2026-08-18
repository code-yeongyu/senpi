import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CodemodeRuntimeAssetEnvironment {
	readonly bunVersion?: string;
	readonly executablePath?: string;
}

export function resolveCodemodeRuntimeAsset(
	localPath: string,
	packageRelativePath: string,
	{ bunVersion = process.versions.bun, executablePath = process.execPath }: CodemodeRuntimeAssetEnvironment = {},
): string {
	if (existsSync(localPath)) {
		return localPath;
	}
	if (bunVersion) {
		const sidecarPath = join(
			dirname(executablePath),
			"node_modules",
			"@code-yeongyu",
			"senpi-codemode",
			"src",
			packageRelativePath,
		);
		if (existsSync(sidecarPath)) {
			return sidecarPath;
		}
	}
	return localPath;
}
