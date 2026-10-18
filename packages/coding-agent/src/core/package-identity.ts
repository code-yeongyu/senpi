import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Nearest `package.json` name plus the resource path relative to that package root, so two
 * physical copies of one package (global install vs worktree checkout) share one identity.
 */
export interface PackageIdentity {
	readonly key: string;
	readonly packageName: string;
}

export function findNearestPackageIdentity(resourcePath: string): PackageIdentity | undefined {
	if (resourcePath.startsWith("<")) {
		return undefined;
	}

	const normalizedResourcePath = resolve(resourcePath);
	let currentPath = resolve(resourcePath);
	try {
		if (!statSync(currentPath).isDirectory()) {
			currentPath = resolve(currentPath, "..");
		}
	} catch {
		currentPath = resolve(currentPath, "..");
	}

	while (true) {
		const packageJsonPath = join(currentPath, "package.json");
		if (existsSync(packageJsonPath)) {
			try {
				const packageJson: { name?: unknown } = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
				if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
					return undefined;
				}
				return {
					key: `${packageJson.name}:${relative(currentPath, normalizedResourcePath)}`,
					packageName: packageJson.name,
				};
			} catch {
				return undefined;
			}
		}

		const parentPath = resolve(currentPath, "..");
		if (parentPath === currentPath) {
			return undefined;
		}
		currentPath = parentPath;
	}
}

/** First path per identity wins (CLI before settings before discovery); unpackaged paths pass through. */
export function dedupePathsByPackageIdentity(paths: readonly string[]): string[] {
	const dedupedPaths: string[] = [];
	const seenIdentityKeys = new Set<string>();

	for (const path of paths) {
		const packageIdentity = findNearestPackageIdentity(path);
		if (packageIdentity) {
			if (seenIdentityKeys.has(packageIdentity.key)) {
				continue;
			}
			seenIdentityKeys.add(packageIdentity.key);
		}
		dedupedPaths.push(path);
	}

	return dedupedPaths;
}
