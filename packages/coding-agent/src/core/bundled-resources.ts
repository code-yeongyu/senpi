import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	findNodePackageDir,
	getDocsPath,
	getExamplesPath,
	getExportTemplateDir,
	getInstallPackageDir,
	getInteractiveAssetsDir,
	getPackageDir,
	getThemesDir,
	isBunBinary,
} from "../config.ts";
import { imagegenSkillPath } from "./extensions/builtin/imagegen/skill-path.ts";

const moduleRequire = createRequire(import.meta.url);
const runningFromSource = fileURLToPath(import.meta.url).includes(`${sep}src${sep}core${sep}`);

/** Engine-owned extension packages; the loader and read permissions share this resolver. */
export const bundledBuiltinExtensions: ReadonlyArray<{ readonly id: string; readonly resolvePackage: () => string }> = [
	{
		id: "codemode",
		resolvePackage: () =>
			resolveBundledPackageJson(
				"@code-yeongyu/senpi-codemode/package.json",
				"senpi-codemode/package.json",
				join("node_modules", "@code-yeongyu", "senpi-codemode", "package.json"),
			),
	},
];

function resolveBundledPackageJson(
	packageSpecifier: string,
	workspaceRelativePath: string,
	binaryRelativePath: string,
): string {
	const packageRoot = getPackageDir();
	const workspacePath = resolve(packageRoot, "..", workspaceRelativePath);
	if (runningFromSource && existsSync(workspacePath)) return workspacePath;
	const binaryPath = resolve(packageRoot, binaryRelativePath);
	if (isBunBinary && existsSync(binaryPath)) return binaryPath;
	try {
		return moduleRequire.resolve(packageSpecifier);
	} catch (error) {
		if (existsSync(workspacePath)) return workspacePath;
		throw error;
	}
}

/** Shipped payload roots, not user-discovered skill or extension directories. */
export function getBundledResourceRoots(): readonly string[] {
	const roots = [
		getThemesDir(),
		getExportTemplateDir(),
		getInteractiveAssetsDir(),
		getDocsPath(),
		getExamplesPath(),
		dirname(imagegenSkillPath()),
	];
	if (!isBunBinary && !runningFromSource) {
		roots.push(getPackageDir(), getInstallPackageDir(), findNodePackageDir(dirname(fileURLToPath(import.meta.url))));
	} else if (isBunBinary) roots.push(dirname(fileURLToPath(import.meta.url)));
	for (const extension of bundledBuiltinExtensions) {
		try {
			roots.push(dirname(extension.resolvePackage()));
		} catch (error) {
			// Missing optional bundled packages are diagnosed by the resource loader.
			if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")) throw error;
		}
	}
	return roots;
}
