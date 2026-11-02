import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRequire = createRequire(import.meta.url);
const TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

export interface NativeModuleCandidateOptions {
	moduleUrl?: string;
	execPath?: string;
	resolvePackage?: (specifier: string) => string;
}

/**
 * Locate the installed TUI package entry.
 *
 * `import.meta.resolve` is tried first because it is the only resolver that answers correctly
 * from an esbuild chunk under Bun: `require.resolve` there returns the bare specifier instead
 * of throwing, and a caller that trusts it builds a relative path out of the package name.
 */
function resolvePackageEntry(resolveOverride?: (specifier: string) => string): string | undefined {
	if (resolveOverride) {
		return resolveOverride(TUI_PACKAGE_NAME);
	}
	try {
		return fileURLToPath(import.meta.resolve(TUI_PACKAGE_NAME));
	} catch {
		// Older runtimes and some bundles have no usable import.meta.resolve.
	}
	return moduleRequire.resolve(TUI_PACKAGE_NAME);
}

export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
	const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
	const candidates: string[] = [];

	try {
		const packageEntry = resolvePackageEntry(options.resolvePackage);
		// A resolver that answers with the bare specifier would yield a relative candidate, and
		// `require` reads that as a package id and never reaches the prebuild.
		if (packageEntry && isAbsolute(packageEntry)) {
			candidates.push(join(dirname(packageEntry), "..", nativePath));
		}
	} catch {
		// Standalone binaries do not have an installed TUI package.
	}

	candidates.push(
		join(moduleDir, "..", nativePath),
		join(moduleDir, nativePath),
		join(dirname(options.execPath ?? process.execPath), nativePath),
	);
	return Array.from(new Set(candidates));
}
