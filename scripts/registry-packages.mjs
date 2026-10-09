// Chord is deliberately absent: the fork does not modify it semantically, so it keeps upstream's
// own release identity and its declared edges resolve to upstream's published version (checked by
// publish-registry-dependencies.test.mjs).
export const registryPackageNames = new Map([
	["@earendil-works/pi-ai", "@code-yeongyu/senpi-ai"],
	["@earendil-works/pi-agent-core", "@code-yeongyu/senpi-agent-core"],
	["@earendil-works/pi-tui", "@code-yeongyu/senpi-tui"],
	["@earendil-works/pi-pty", "@code-yeongyu/senpi-pty"],
	["@earendil-works/pi-telemetry", "@code-yeongyu/senpi-telemetry"],
	["@code-yeongyu/senpi-codemode", "@code-yeongyu/senpi-codemode"],
	["@code-yeongyu/senpi", "@code-yeongyu/senpi"],
]);

export const registrySourcePackageNames = new Set(registryPackageNames.keys());

const publishedRegistryNames = new Set(registryPackageNames.values());

// A fork-scope package outside the publish set is never on the registry, so no published manifest may
// declare it: every declared dependency is resolved from the registry at install time (senpi#2141).
export function isUnpublishedForkPackage(packageName) {
	return packageName.startsWith("@code-yeongyu/") && !publishedRegistryNames.has(packageName);
}

export function resolveRegistryPackages(packages) {
	const resolved = new Map();
	for (const pkg of packages) {
		if (!registrySourcePackageNames.has(pkg.name)) {
			continue;
		}
		if (resolved.has(pkg.name)) {
			throw new Error(`Duplicate registry package source: ${pkg.name}`);
		}
		resolved.set(pkg.name, pkg);
	}

	const missing = [...registrySourcePackageNames].filter((name) => !resolved.has(name));
	if (missing.length > 0) {
		throw new Error(`Missing registry package sources: ${missing.join(", ")}`);
	}

	return [...resolved.values()].map((pkg) => ({
		...pkg,
		registryName: registryPackageNames.get(pkg.name),
	}));
}
