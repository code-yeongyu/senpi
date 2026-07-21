#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	copyLockEntry,
	copyPackageJsonEntry,
	packageDependencies,
	rebaseResolvedLockPath,
	registryTarballUrl,
	resolveExternalDependency,
	sortedObject,
	sortedPackageEntry,
} from "./install-lock-utils.mjs";
import { validateGeneratedFiles } from "./install-lock-validation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const outputDir = join(codingAgentDir, "install-lock");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const outputPackageJsonPath = join(outputDir, "package.json");
const outputLockfilePath = join(outputDir, "package-lock.json");
const internalPackagePrefixes = ["@earendil-works/pi-", "@code-yeongyu/senpi"];
const installPackageName = "@code-yeongyu/senpi-install";
const allowedInstallScriptPackages = new Map([
	["@google/genai@1.52.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.6.4", "postinstall only warns about protobufjs version scheme mismatches"],
]);

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function dependencyItems(entry) {
	return [
		...Object.entries(entry.dependencies ?? {}).map(([name, spec]) => ({ name, optional: false, spec })),
		...Object.entries(entry.optionalDependencies ?? {}).map(([name, spec]) => ({ name, optional: true, spec })),
	];
}

function getInternalWorkspaces(lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.name || !entry.version) {
			continue;
		}
		if (!internalPackagePrefixes.some((prefix) => entry.name.startsWith(prefix))) {
			continue;
		}

		workspaces.set(entry.name, {
			lockPath,
			packageJson: readJson(join(repoRoot, lockPath, "package.json")),
		});
	}

	return workspaces;
}

function addInternalWorkspace(installLockPackages, addedPaths, queue, name, workspace) {
	const packageJson = workspace.packageJson;
	const outputPath = `node_modules/${name}`;
	const entry = copyPackageJsonEntry(packageJson, { includeName: false });
	entry.resolved = registryTarballUrl(name, packageJson.version);

	installLockPackages[outputPath] = sortedPackageEntry(entry);
	addedPaths.add(outputPath);

	for (const dependency of dependencyItems(packageJson)) {
		queue.push({
			...dependency,
			from: outputPath,
			resolveFrom: workspace.lockPath,
			sourceBase: workspace.lockPath,
			outputBase: outputPath,
		});
	}
}

function addExternalPackage(lockPackages, installLockPackages, addedPaths, queue, item) {
	let lockPath;
	try {
		lockPath = resolveExternalDependency(lockPackages, item.name, item.resolveFrom, item.spec);
	} catch (error) {
		if (item.optional) {
			return;
		}
		throw error;
	}
	const outputPath = rebaseResolvedLockPath(lockPath, item.sourceBase, item.outputBase);
	if (addedPaths.has(outputPath)) {
		return;
	}

	const entry = lockPackages[lockPath];
	installLockPackages[outputPath] = copyLockEntry(entry);
	addedPaths.add(outputPath);

	for (const dependency of dependencyItems(entry)) {
		queue.push({
			...dependency,
			from: outputPath,
			resolveFrom: lockPath,
			sourceBase: item.sourceBase,
			outputBase: item.outputBase,
		});
	}
}

function createInstallerPackageJson(codingAgentPackage) {
	const packageJson = {
		name: installPackageName,
		version: codingAgentPackage.version,
		private: true,
		description: "Lockfile root used by the Pi installer and updater.",
		dependencies: {
			[codingAgentPackage.name]: codingAgentPackage.version,
		},
	};
	if (codingAgentPackage.overrides) {
		packageJson.overrides = codingAgentPackage.overrides;
	}
	if (codingAgentPackage.engines) {
		packageJson.engines = codingAgentPackage.engines;
	}
	return packageJson;
}

function createRootLockEntry(installerPackageJson) {
	const entry = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		dependencies: installerPackageJson.dependencies,
	};
	if (installerPackageJson.engines) {
		entry.engines = installerPackageJson.engines;
	}
	return sortedPackageEntry(entry);
}

function generateInstallLock() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const installerPackageJson = createInstallerPackageJson(codingAgentPackage);
	const internalWorkspaces = getInternalWorkspaces(lockPackages);
	const installLockPackages = {
		"": createRootLockEntry(installerPackageJson),
	};
	const addedPaths = new Set([""]);
	const internalNames = new Set();
	const queue = dependencyItems(installerPackageJson).map((dependency) => ({
		...dependency,
		from: "",
		resolveFrom: "",
		sourceBase: "",
		outputBase: "",
	}));

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}

		const workspace = internalWorkspaces.get(item.name);
		if (workspace) {
			const outputPath = `node_modules/${item.name}`;
			internalNames.add(item.name);
			if (!addedPaths.has(outputPath)) {
				addInternalWorkspace(installLockPackages, addedPaths, queue, item.name, workspace);
			}
			continue;
		}

		addExternalPackage(lockPackages, installLockPackages, addedPaths, queue, item);
	}

	const installLock = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(installLockPackages),
	};

	validateGeneratedFiles({
		installerPackageJson,
		installLock,
		internalNames,
		internalPackagePrefixes,
		allowedInstallScriptPackages,
	});
	return { installerPackageJson, installLock };
}

try {
	const { installerPackageJson, installLock } = generateInstallLock();
	const packageJsonContent = `${JSON.stringify(installerPackageJson, null, "\t")}\n`;
	const lockfileContent = `${JSON.stringify(installLock, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(outputPackageJsonPath) || !existsSync(outputLockfilePath)) {
			console.error("packages/coding-agent/install-lock is missing generated files.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		const currentPackageJson = readFileSync(outputPackageJsonPath, "utf8");
		const currentLockfile = readFileSync(outputLockfilePath, "utf8");
		if (currentPackageJson !== packageJsonContent || currentLockfile !== lockfileContent) {
			console.error("packages/coding-agent/install-lock is out of date.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/install-lock is up to date.");
	} else {
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(outputPackageJsonPath, packageJsonContent);
		writeFileSync(outputLockfilePath, lockfileContent);
		const packageCount = Object.keys(installLock.packages).length - 1;
		const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
			.length;
		console.log(
			`Wrote packages/coding-agent/install-lock/package.json and package-lock.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
