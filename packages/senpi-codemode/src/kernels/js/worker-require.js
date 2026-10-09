import { createRequire, isBuiltin } from "node:module";

// `require` in a cell resolves the way `import` does there: builtins natively, relative paths from the cell's
// directory, bare packages from the session's project first and then its managed package environment
// (%bun add / %npm add). It uses the runtime's own CommonJS loader, so JSON files and the `require` export conditions
// behave as in Node. Like Node's own `require`, it carries `resolve`, `resolve.paths` and `cache`.
export function createCellRequire(context) {
	const requirers = () => {
		const { cwdUrl, packageRootUrl } = context();
		const fromCwd = createRequire(new URL("package.json", cwdUrl));
		const fromPackages = packageRootUrl ? createRequire(new URL("package.json", packageRootUrl)) : undefined;
		return { fromCwd, fromPackages };
	};
	const isPathLike = (name) => name.startsWith(".") || name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name);
	// The one lookup both the call and `resolve` use, so they can never pick different copies of a package. Builtins
	// (`fs`, `node:fs`, Bun's `bun:sqlite`) and paths resolve natively; a bare name the project does not have falls
	// back to the managed environment, and a miss there reports the project's own not-found error.
	const resolve = function resolve(specifier, options) {
		const name = String(specifier);
		const { fromCwd, fromPackages } = requirers();
		if (isBuiltin(name) || isPathLike(name) || fromPackages === undefined || options?.paths !== undefined) {
			return fromCwd.resolve(name, options);
		}
		try {
			return fromCwd.resolve(name, options);
		} catch (error) {
			if (error?.code !== "MODULE_NOT_FOUND") throw error;
			try {
				return fromPackages.resolve(name, options);
			} catch (fallback) {
				throw fallback?.code === "MODULE_NOT_FOUND" ? error : fallback;
			}
		}
	};
	resolve.paths = (specifier) => {
		const name = String(specifier);
		const { fromCwd, fromPackages } = requirers();
		const own = fromCwd.resolve.paths(name);
		if (own === null || fromPackages === undefined || isPathLike(name)) return own;
		return [...new Set([...own, ...(fromPackages.resolve.paths(name) ?? [])])];
	};
	// The call loads exactly what `resolve` names: a builtin id or an absolute file, through the runtime's loader.
	const require = function require(specifier) {
		return requirers().fromCwd(resolve(specifier));
	};
	require.resolve = resolve;
	// One CommonJS cache per runtime: the cell's view is the loader's own, so deleting an entry forces a reload.
	Object.defineProperty(require, "cache", { enumerable: true, get: () => createRequire(import.meta.url).cache });
	return require;
}

export { createRequire };
