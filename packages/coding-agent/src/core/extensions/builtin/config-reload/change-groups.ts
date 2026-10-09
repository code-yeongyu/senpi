import { relative, resolve, sep } from "node:path";
import type { WatchTarget } from "./watch-engine.ts";

export type ActiveTarget = {
	readonly registrationId: string;
	readonly target: WatchTarget;
	/** Presence targets rebuild the watcher set once this missing path appears. */
	readonly rearmOnCreation?: string;
};

export function groupChangedPaths(
	paths: readonly string[],
	targets: readonly ActiveTarget[],
	rearmedContainers: readonly string[],
): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const path of paths) {
		let matched = false;
		for (const activeTarget of targets) {
			if (!targetMatchesPath(activeTarget.target, path)) continue;
			matched = true;
			// The project container only rearms discovery; newly discovered config files carry the change.
			if (activeTarget.target.id === "builtin-project-presence" && rearmedContainers.includes(resolve(path)))
				continue;
			const group = groups.get(activeTarget.registrationId) ?? [];
			if (!group.includes(path)) group.push(path);
			groups.set(activeTarget.registrationId, group);
		}
		if (!matched) {
			const group = groups.get("builtin") ?? [];
			group.push(path);
			groups.set("builtin", group);
		}
	}
	return groups;
}

function targetMatchesPath(target: WatchTarget, path: string): boolean {
	const relativePath = relative(resolve(target.path), resolve(path));
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return false;
	switch (target.kind) {
		case "dir":
			if (relativePath.includes(sep)) return false;
			break;
		case "dir-recursive":
			break;
		default:
			return target.kind satisfies never;
	}
	if (
		target.allowList &&
		!target.allowList.some((allowed) => relativePath === allowed || relativePath.startsWith(`${allowed}${sep}`))
	) {
		return false;
	}
	return target.filter?.(relativePath) ?? true;
}
