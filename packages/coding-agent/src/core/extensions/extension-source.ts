/** Direct files discovered by the loader, package resolver, and reload watcher. */
export function isExtensionSource(name: string): boolean {
	return /\.(?:ts|js|mts|mjs)$/.test(name);
}

export function unsupportedExtensionWarning(path: string): { path: string; warning: string } {
	return { path, warning: `Skipped extension ${path}: expected a .ts, .js, .mts, or .mjs file.` };
}
