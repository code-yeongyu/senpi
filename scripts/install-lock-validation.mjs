import { isExactVersionSpec, packageNameFromLockPath, resolveExternalDependency } from "./install-lock-utils.mjs";

export function validateGeneratedFiles(options) {
	const { installerPackageJson, installLock, internalNames, internalPackagePrefixes, allowedInstallScriptPackages } =
		options;
	const errors = [];
	const rootEntry = installLock.packages[""];
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	if (installLock.lockfileVersion !== 3) {
		errors.push("package-lock.json must use lockfileVersion 3");
	}
	if (installLock.name !== installerPackageJson.name) {
		errors.push(`lockfile name ${installLock.name} does not match package.json name ${installerPackageJson.name}`);
	}
	if (installLock.version !== installerPackageJson.version) {
		errors.push(
			`lockfile version ${installLock.version} does not match package.json version ${installerPackageJson.version}`,
		);
	}
	if (JSON.stringify(rootEntry?.dependencies ?? {}) !== JSON.stringify(installerPackageJson.dependencies)) {
		errors.push("lockfile root dependencies do not match package.json dependencies");
	}

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		const packageName = packageNameFromLockPath(lockPath);
		if (packageName) {
			includedPackageNames.add(packageName);
		}
		if (entry.link) {
			errors.push(`${lockPath} is a link entry`);
		}
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		if (entry.dev || entry.devOptional || entry.extraneous) {
			errors.push(`${lockPath || "root"} contains dev/extraneous metadata`);
		}
		if (
			internalPackagePrefixes.some((prefix) => packageName?.startsWith(prefix)) &&
			entry.version !== installerPackageJson.version
		) {
			errors.push(`${lockPath} internal package version ${entry.version} does not match ${installerPackageJson.version}`);
		}
		if (entry.hasInstallScript) {
			if (!packageName || !entry.version) {
				errors.push(`${lockPath || "root"} has install scripts but no package name/version`);
			} else {
				const packageId = `${packageName}@${entry.version}`;
				if (allowedInstallScriptPackages.has(packageId)) {
					seenAllowedInstallScriptPackages.add(packageId);
				} else {
					errors.push(
						`${lockPath} has install scripts (${packageId}). Review it and add it to allowedInstallScriptPackages if intentional.`,
					);
				}
			}
		}
	}

	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}

	for (const name of internalNames) {
		if (!includedPackageNames.has(name)) {
			errors.push(`internal dependency ${name} is missing`);
		}
	}

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		for (const [dependencyName, dependencySpec] of Object.entries(entry.dependencies ?? {})) {
			let dependencyLockPath;
			try {
				dependencyLockPath = resolveExternalDependency(installLock.packages, dependencyName, lockPath, dependencySpec);
			} catch {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
				continue;
			}

			const dependencyEntry = installLock.packages[dependencyLockPath];
			if (isExactVersionSpec(dependencySpec) && dependencyEntry.version !== dependencySpec) {
				errors.push(
					`${lockPath || "root"} dependency ${dependencyName}@${dependencySpec} resolves to ${dependencyEntry.version}`,
				);
			}
		}
		for (const [dependencyName, dependencySpec] of Object.entries(entry.optionalDependencies ?? {})) {
			let dependencyLockPath;
			try {
				dependencyLockPath = resolveExternalDependency(installLock.packages, dependencyName, lockPath, dependencySpec);
			} catch {
				continue;
			}

			const dependencyEntry = installLock.packages[dependencyLockPath];
			if (isExactVersionSpec(dependencySpec) && dependencyEntry.version !== dependencySpec) {
				errors.push(
					`${lockPath || "root"} optional dependency ${dependencyName}@${dependencySpec} resolves to ${dependencyEntry.version}`,
				);
			}
		}
	}

	const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
		.length;
	if (platformPackageCount === 0) {
		errors.push("no platform-specific optional dependency entries found");
	}

	if (errors.length > 0) {
		throw new Error(`Generated installer lock failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}
