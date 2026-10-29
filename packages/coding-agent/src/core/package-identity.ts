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

/** The nearest package root and its name; `null` when that package.json has no usable name, or none exists. */
type NearestPackage = { readonly root: string; readonly name: string } | null;

function readNearestPackage(packageRoot: string): NearestPackage {
	try {
		const packageJson: { name?: unknown } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
		return typeof packageJson.name === "string" && packageJson.name.length > 0
			? { root: packageRoot, name: packageJson.name }
			: null;
	} catch {
		return null;
	}
}

/**
 * Walks up from `startDir` to the nearest package.json. `memo` records the answer for every directory
 * walked, so many resources under one folder probe each ancestor once instead of once per resource
 * (omo#11437: one walk to the filesystem root per installed skill on every session open).
 */
function findNearestPackage(startDir: string, memo: Map<string, NearestPackage>): NearestPackage {
	const walked: string[] = [];
	let currentPath = startDir;
	let nearest: NearestPackage = null;
	while (true) {
		const known = memo.get(currentPath);
		if (known !== undefined) {
			nearest = known;
			break;
		}
		walked.push(currentPath);
		if (existsSync(join(currentPath, "package.json"))) {
			nearest = readNearestPackage(currentPath);
			break;
		}
		const parentPath = resolve(currentPath, "..");
		if (parentPath === currentPath) break;
		currentPath = parentPath;
	}
	for (const path of walked) memo.set(path, nearest);
	return nearest;
}

export function findNearestPackageIdentity(resourcePath: string): PackageIdentity | undefined {
	return identityOf(resourcePath, new Map());
}

function identityOf(resourcePath: string, memo: Map<string, NearestPackage>): PackageIdentity | undefined {
	if (resourcePath.startsWith("<")) {
		return undefined;
	}

	const normalizedResourcePath = resolve(resourcePath);
	let startDir = normalizedResourcePath;
	try {
		if (!statSync(startDir).isDirectory()) {
			startDir = resolve(startDir, "..");
		}
	} catch {
		startDir = resolve(startDir, "..");
	}

	const nearest = findNearestPackage(startDir, memo);
	return nearest === null
		? undefined
		: { key: `${nearest.name}:${relative(nearest.root, normalizedResourcePath)}`, packageName: nearest.name };
}

/** First path per identity wins (CLI before settings before discovery); unpackaged paths pass through. */
export function dedupePathsByPackageIdentity(paths: readonly string[]): string[] {
	const dedupedPaths: string[] = [];
	const seenIdentityKeys = new Set<string>();
	const memo = new Map<string, NearestPackage>();

	for (const path of paths) {
		const packageIdentity = identityOf(path, memo);
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
