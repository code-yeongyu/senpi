import { registryPackageNames } from "./registry-packages.mjs";
export function buildPublishArgs({ githubActions }) {
	if (!githubActions) {
		throw new Error("GitHub Actions is required for provenance-backed npm publication.");
	}

	const args = ["publish", "--access", "public", "--tag", "latest"];
	args.push("--provenance");
	args.push("--ignore-scripts");
	return args;
}

// Packages published as TypeScript source for Bun: they have no dist/ to build. Keyed by published (registry) name;
// a package whose source manifest keeps an upstream name is looked up through the registry map first.
const sourceOnlyRegistryPackages = new Set(["@code-yeongyu/senpi-codemode", "@code-yeongyu/senpi-storage-sqlite-bun"]);

export function requiresBuildOutput(sourcePackageName) {
	return !sourceOnlyRegistryPackages.has(registryPackageNames.get(sourcePackageName) ?? sourcePackageName);
}
