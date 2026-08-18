const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function hasInstallScript(scripts) {
	return ["preinstall", "install", "postinstall"].some((name) => typeof scripts?.[name] === "string");
}

async function fetchRegistryPackage(packageName, version) {
	const encodedName = packageName.replace("/", "%2F");
	const response = await fetch(`https://registry.npmjs.org/${encodedName}/${version}`);
	if (!response.ok) {
		throw new Error(`Cannot fetch ${packageName}@${version}: registry returned HTTP ${response.status}.`);
	}
	return response.json();
}

export async function resolveOptionalRegistryPackage(packageName, version, options = {}) {
	if (!EXACT_VERSION.test(version)) {
		throw new Error(
			`Cannot resolve optional dependency ${packageName}@${version} outside the host lockfile: ` +
				"the version must be exact.",
		);
	}

	const packageJson = await (options.fetchPackage ?? fetchRegistryPackage)(packageName, version);
	if (packageJson.name !== packageName || packageJson.version !== version) {
		throw new Error(
			`Registry metadata mismatch for ${packageName}@${version}: received ` +
				`${packageJson.name ?? "unknown"}@${packageJson.version ?? "unknown"}.`,
		);
	}
	if (typeof packageJson.dist?.tarball !== "string" || typeof packageJson.dist?.integrity !== "string") {
		throw new Error(`Registry metadata for ${packageName}@${version} is missing dist.tarball or dist.integrity.`);
	}

	const entry = {
		version,
		resolved: packageJson.dist.tarball,
		integrity: packageJson.dist.integrity,
	};
	for (const field of [
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
	]) {
		if (packageJson[field] !== undefined) {
			entry[field] = packageJson[field];
		}
	}
	entry.optional = true;
	if (hasInstallScript(packageJson.scripts)) {
		entry.hasInstallScript = true;
	}
	return entry;
}
