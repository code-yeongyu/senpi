#!/usr/bin/env node
// Keep bun.lock's per-workspace dependency specifiers equal to the workspace manifests (senpi#2352).
//
// Bun 1.4.2 does not reach a fixed point when it resolves against a seeded bun.lock after a
// release bumps every workspace version: the first `bun install --lockfile-only` pass rewrites
// each workspace's "version" but keeps the previously recorded specifiers of the workspace
// packages it depends on, a second pass only fixes some of them, and leaf workspaces (nothing in
// the monorepo depends on them) keep the stale range forever. A fresh clone's `bun install` then
// rewrites bun.lock. These helpers let the regenerator repair the seed before Bun runs and audit
// the result after it.

export const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** bun.lock is JSON with trailing commas; drop the commas that sit outside strings, then parse. */
export function parseBunLock(text) {
	let output = "";
	let inString = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			output += char;
			if (char === "\\") {
				output += text[++index] ?? "";
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') inString = true;
		if (char === ",") {
			const next = text.slice(index + 1).match(/^\s*(.)/s)?.[1];
			if (next === "}" || next === "]") continue;
		}
		output += char;
	}
	return JSON.parse(output);
}

/** The bun.lock "workspaces" key of a manifest path: "" for the root, otherwise its directory. */
export function workspaceKey(manifestPath) {
	return manifestPath === "package.json" ? "" : manifestPath.slice(0, -"/package.json".length);
}

/** A specifier that can only resolve to the local workspace at `version`, so rewriting it never changes a resolution. */
export function targetsLocalWorkspace(specifier, version) {
	if (/^(workspace:)?[*^~]$/.test(specifier)) return true;
	const bare = specifier.replace(/^workspace:/, "").replace(/^[\^~]/, "");
	return typeof version === "string" && bare === version;
}

/** Every dependency specifier bun.lock records differently from the workspace manifest that declares it. */
export function findSpecifierMismatches(lock, manifests) {
	const mismatches = [];
	for (const [manifestPath, manifest] of manifests) {
		const key = workspaceKey(manifestPath);
		const locked = lock.workspaces?.[key];
		if (!locked) continue;
		for (const group of DEPENDENCY_GROUPS) {
			const declared = manifest[group] ?? {};
			const recorded = locked[group] ?? {};
			for (const name of new Set([...Object.keys(declared), ...Object.keys(recorded)])) {
				if (declared[name] === recorded[name]) continue;
				mismatches.push({ workspace: key, group, name, declared: declared[name], recorded: recorded[name] });
			}
		}
	}
	return mismatches;
}

/**
 * Rewrite, in the bun.lock text, every stale specifier of a dependency on a local workspace
 * package whose declared range targets that workspace's current version. External and
 * registry-resolved specifiers are left for Bun to re-resolve. Returns { text, repaired }.
 */
export function repairWorkspaceSpecifiers(text, manifests) {
	const localVersions = new Map([...manifests.values()].filter((m) => m.name).map((m) => [m.name, m.version]));
	const repairable = findSpecifierMismatches(parseBunLock(text), manifests).filter(
		(mismatch) =>
			mismatch.declared !== undefined &&
			mismatch.recorded !== undefined &&
			localVersions.has(mismatch.name) &&
			targetsLocalWorkspace(mismatch.declared, localVersions.get(mismatch.name)),
	);
	let repairedText = text;
	for (const mismatch of repairable) {
		repairedText = replaceInWorkspaceGroup(repairedText, mismatch);
	}
	return { text: repairedText, repaired: repairable };
}

/** Replace one `"name": "recorded"` entry inside `workspaces[workspace][group]`, touching nothing else. */
function replaceInWorkspaceGroup(text, { workspace, group, name, recorded, declared }) {
	const workspacesStart = text.indexOf('"workspaces": {');
	const workspaceStart = text.indexOf(`${JSON.stringify(workspace)}: {`, workspacesStart);
	const groupStart = workspaceStart < 0 ? -1 : text.indexOf(`${JSON.stringify(group)}: {`, workspaceStart);
	const groupEnd = groupStart < 0 ? -1 : text.indexOf("}", groupStart);
	const entry = `${JSON.stringify(name)}: ${JSON.stringify(recorded)}`;
	const entryStart = groupStart < 0 ? -1 : text.indexOf(entry, groupStart);
	if (workspacesStart < 0 || entryStart < 0 || entryStart > groupEnd) {
		throw new Error(`cannot locate ${name} in bun.lock workspaces["${workspace}"].${group}`);
	}
	return `${text.slice(0, entryStart)}${JSON.stringify(name)}: ${JSON.stringify(declared)}${text.slice(entryStart + entry.length)}`;
}

export function formatMismatch({ workspace, group, name, declared, recorded }) {
	return `workspaces["${workspace}"].${group}.${name}: bun.lock ${recorded ?? "<missing>"}, package.json ${declared ?? "<missing>"}`;
}
