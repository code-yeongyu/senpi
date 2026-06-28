import { posix } from "node:path";

export function packageDependencies(entry) {
	return {
		...(entry.dependencies ?? {}),
		...(entry.optionalDependencies ?? {}),
	};
}

export function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

export function sortedPackageEntry(entry) {
	const fieldOrder = [
		"name",
		"version",
		"resolved",
		"integrity",
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
		"optional",
		"hasInstallScript",
		"deprecated",
		"funding",
	];
	const sorted = {};

	for (const field of fieldOrder) {
		if (entry[field] !== undefined) {
			sorted[field] = entry[field];
		}
	}
	for (const [field, value] of Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) {
		if (sorted[field] === undefined) {
			sorted[field] = value;
		}
	}
	return sorted;
}

export function copyLockEntry(entry) {
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	delete copied.extraneous;
	delete copied.link;
	return sortedPackageEntry(copied);
}

export function copyPackageJsonEntry(packageJson, options) {
	const entry = options.includeName
		? { name: packageJson.name, version: packageJson.version }
		: { version: packageJson.version };

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

	return sortedPackageEntry(entry);
}

export function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) {
		return undefined;
	}

	const parts = lockPath.slice(index + marker.length).split("/");
	if (parts[0]?.startsWith("@")) {
		return `${parts[0]}/${parts[1]}`;
	}
	return parts[0];
}

export function registryTarballUrl(packageName, version) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

export function isExactVersionSpec(spec) {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
}

function candidateSatisfiesSpec(entry, expectedSpec) {
	return !isExactVersionSpec(expectedSpec) || entry.version === expectedSpec;
}

export function resolveExternalDependency(lockPackages, packageName, fromLockPath, expectedSpec = "") {
	const candidateDirs = [];
	let current = fromLockPath;

	while (current) {
		candidateDirs.push(current);
		const parent = posix.dirname(current);
		if (parent === "." || parent === current) {
			break;
		}
		current = parent;
	}
	candidateDirs.push("");

	const tried = new Set();
	for (const directory of candidateDirs) {
		const candidate = directory ? `${directory}/node_modules/${packageName}` : `node_modules/${packageName}`;
		if (tried.has(candidate)) {
			continue;
		}
		tried.add(candidate);

		const entry = lockPackages[candidate];
		if (entry && !entry.link && candidateSatisfiesSpec(entry, expectedSpec)) {
			return candidate;
		}
	}

	const suffix = `node_modules/${packageName}`;
	const matches = Object.entries(lockPackages)
		.filter(
			([lockPath, entry]) =>
				!entry.link &&
				candidateSatisfiesSpec(entry, expectedSpec) &&
				(lockPath === suffix || lockPath.endsWith(`/${suffix}`)),
		)
		.map(([lockPath]) => lockPath);

	if (matches.length === 1) {
		return matches[0];
	}

	throw new Error(
		`Cannot resolve ${packageName} from ${fromLockPath || "root"}. ` +
			(matches.length > 1 ? `Matches: ${matches.join(", ")}` : "No matching lockfile entry found."),
	);
}

export function rebaseResolvedLockPath(lockPath, sourceBase, outputBase) {
	if (!sourceBase || !outputBase) {
		return lockPath;
	}
	const nestedPrefix = `${sourceBase}/node_modules/`;
	if (!lockPath.startsWith(nestedPrefix)) {
		return lockPath;
	}
	return `${outputBase}/node_modules/${lockPath.slice(nestedPrefix.length)}`;
}
