#!/usr/bin/env node
// Decides where every publish-deps.lock.json entry lands in the staged
// packages/coding-agent/node_modules tree.
//
// The manifest keeps the ROOT lock's two-level placements: what coding-agent resolves itself
// sits at packages/coding-agent/node_modules/<pkg>, everything else at node_modules/<pkg>,
// nested as npm decided. The staged tree has one level, so a package npm placed at both
// levels in different versions cannot keep both top-level slots. The workspace-local copy is
// what coding-agent and every workspace-local dependency resolve, so it keeps the slot; the
// root copy is re-nested under each staged dependent whose nearest placement in the manifest
// was that root slot (exactly the module npm resolved for it), recursively for the root
// copy's own root-resolved dependencies. No range is evaluated: npm's placements decide.

export const WORKSPACE_PREFIX = "packages/coding-agent/";

// "node_modules/a/node_modules/@s/b" -> ["a", "@s/b"]. Anything that is not a chain of
// package directories (the root "", workspace paths, dot entries) yields undefined.
export function lockPathPackageChain(lockPath) {
	const parts = lockPath.split("/");
	const chain = [];
	let index = 0;
	while (index < parts.length) {
		if (parts[index] !== "node_modules") return undefined;
		const name = parts[index + 1];
		if (!name || name.startsWith(".")) return undefined;
		if (name.startsWith("@")) {
			const scopedName = parts[index + 2];
			if (!scopedName) return undefined;
			chain.push(`${name}/${scopedName}`);
			index += 3;
		} else {
			chain.push(name);
			index += 2;
		}
	}
	return chain.length > 0 ? chain : undefined;
}

export function chainLockPath(chain) {
	return chain.map((name) => `node_modules/${name}`).join("/");
}

function splitManifestPath(manifestPath) {
	const prefix = manifestPath.startsWith(WORKSPACE_PREFIX) ? WORKSPACE_PREFIX : "";
	return { prefix, chain: lockPathPackageChain(manifestPath.slice(prefix.length)) };
}

// Peer edges are not placement edges: npm never nests a peer under its dependent, and
// npm-packlist (bun pm pack alike) refuses to pack a peer edge of a bundled package, so a
// copy re-nested for a peer-only dependent could never reach the tarball. Such a dependent
// resolves the top-level copy, exactly as it does in npm's own install.
function declaredDependencyNames(entry) {
	return Object.keys({ ...entry.dependencies, ...entry.optionalDependencies });
}

// The manifest path npm resolved `name` to from the package at manifestPath: the nearest
// node_modules/<name> walking up through its ancestors, then the workspace level, then root.
function resolvedManifestPath(packages, manifestPath, name) {
	const { prefix, chain } = splitManifestPath(manifestPath);
	for (let depth = chain.length; depth >= 0; depth -= 1) {
		const base = depth === 0 ? prefix : `${prefix}${chainLockPath(chain.slice(0, depth))}/`;
		const candidate = `${base}node_modules/${name}`;
		if (packages[candidate]) return candidate;
	}
	return prefix === "" ? undefined : packages[`node_modules/${name}`] ? `node_modules/${name}` : undefined;
}

export function resolvePublishPlacements(packages, internalPackageNames) {
	const stageable = [];
	for (const [manifestPath, entry] of Object.entries(packages)) {
		const { chain } = splitManifestPath(manifestPath);
		if (chain && !internalPackageNames.has(chain[0])) stageable.push({ manifestPath, chain, entry });
	}
	// A root slot loses to a workspace-local copy of another version.
	const losers = new Set();
	for (const { manifestPath, chain, entry } of stageable) {
		if (manifestPath.startsWith(WORKSPACE_PREFIX) || chain.length !== 1) continue;
		const local = packages[`${WORKSPACE_PREFIX}${manifestPath}`];
		if (local && local.version !== entry.version) losers.add(manifestPath);
	}

	const placementsByPath = new Map();
	const resolving = new Set();
	function placementsOf(manifestPath) {
		const known = placementsByPath.get(manifestPath);
		if (known) return known;
		const { prefix, chain } = splitManifestPath(manifestPath);
		if (!losers.has(manifestPath)) {
			// A nested entry follows its manifest parent wherever that parent is placed: it is
			// the parent's own resolution and must move (or multiply) with it.
			const name = chain.at(-1);
			const parentPath = chain.length > 1 ? `${prefix}${chainLockPath(chain.slice(0, -1))}` : undefined;
			const placements =
				parentPath !== undefined && packages[parentPath]
					? placementsOf(parentPath).map((parent) => `${parent}/node_modules/${name}`)
					: [chainLockPath(chain)];
			placementsByPath.set(manifestPath, placements);
			return placements;
		}
		if (resolving.has(manifestPath)) {
			throw new Error(`publish-deps.lock.json root placement ${manifestPath} depends on itself through its dependents; regenerate the manifest.`);
		}
		resolving.add(manifestPath);
		const name = chain[0];
		const placements = [];
		for (const dependent of stageable) {
			if (!declaredDependencyNames(dependent.entry).includes(name)) continue;
			if (resolvedManifestPath(packages, dependent.manifestPath, name) !== manifestPath) continue;
			for (const parent of placementsOf(dependent.manifestPath)) placements.push(`${parent}/node_modules/${name}`);
		}
		resolving.delete(manifestPath);
		placementsByPath.set(manifestPath, placements);
		return placements;
	}

	const staged = new Map();
	for (const { manifestPath, chain, entry } of stageable) {
		for (const lockPath of placementsOf(manifestPath)) {
			const previous = staged.get(lockPath);
			if (previous && previous.entry.version !== entry.version) {
				throw new Error(
					`publish-deps.lock.json places ${previous.entry.version} and ${entry.version} of ${chain.at(-1)} at the same staged path ${lockPath}; regenerate the manifest.`,
				);
			}
			staged.set(lockPath, { lockPath, chain: lockPathPackageChain(lockPath), entry });
		}
	}
	// Parent before child: shallower placements first, then a stable order within a depth.
	return [...staged.values()].sort((a, b) => a.chain.length - b.chain.length || a.lockPath.localeCompare(b.lockPath));
}
