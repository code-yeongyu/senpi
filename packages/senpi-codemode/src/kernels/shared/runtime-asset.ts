import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CodemodeRuntimeAssetEnvironment {
	readonly bunVersion?: string;
	readonly executablePath?: string;
}

export class CodemodeRuntimeAssetMissingError extends Error {
	readonly packageRelativePath: string;
	readonly localPath: string;
	readonly sidecarPath: string;
	readonly executablePath: string;

	constructor(packageRelativePath: string, localPath: string, sidecarPath: string, executablePath: string) {
		super(
			`codemode runtime asset ${packageRelativePath} is unavailable: module-relative path ${localPath} is not readable and the codemode sidecar is missing beside the executable ${executablePath} (expected ${sidecarPath}). Ship node_modules/@code-yeongyu/senpi-codemode next to the executable.`,
		);
		this.name = "CodemodeRuntimeAssetMissingError";
		this.packageRelativePath = packageRelativePath;
		this.localPath = localPath;
		this.sidecarPath = sidecarPath;
		this.executablePath = executablePath;
	}
}

export function isBunVirtualPath(path: string): boolean {
	return path.includes("/$bunfs/") || path.includes("~BUN") || path.includes("%7EBUN");
}

function sidecarPathFor(packageRelativePath: string, executablePath: string): string {
	return join(dirname(executablePath), "node_modules", "@code-yeongyu", "senpi-codemode", "src", packageRelativePath);
}

export function requireCodemodeRuntimeAsset(
	localPath: string,
	packageRelativePath: string,
	{ executablePath = process.execPath }: CodemodeRuntimeAssetEnvironment = {},
): string {
	const sidecarPath = sidecarPathFor(packageRelativePath, executablePath);
	if (!isBunVirtualPath(localPath) && existsSync(localPath)) return localPath;
	if (existsSync(sidecarPath)) return sidecarPath;
	throw new CodemodeRuntimeAssetMissingError(packageRelativePath, localPath, sidecarPath, executablePath);
}

export function resolveCodemodeRuntimeAsset(
	localPath: string,
	packageRelativePath: string,
	{ bunVersion = process.versions.bun, executablePath = process.execPath }: CodemodeRuntimeAssetEnvironment = {},
): string {
	if (existsSync(localPath)) return localPath;
	if (bunVersion) {
		const sidecarPath = sidecarPathFor(packageRelativePath, executablePath);
		if (existsSync(sidecarPath)) return sidecarPath;
	}
	return localPath;
}
