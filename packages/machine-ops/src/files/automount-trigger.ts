import { readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { type MountEntry, readMountTable } from "./mount-table.ts";

const MOUNT_VIEW_MAX_AGE_MS = 60_000;

/** The mount table plus each top-level symlink that names an automount root (macOS `/home` -> `/System/Volumes/Data/home`). */
export interface MountView {
	readonly mounts: readonly MountEntry[];
	readonly aliases: ReadonlyMap<string, string>;
}

function isWithin(root: string, path: string): boolean {
	if (root === sep) return path.startsWith(sep);
	return path === root || path.startsWith(`${root}${sep}`);
}

function throughAlias(path: string, aliases: ReadonlyMap<string, string>): string {
	for (const [alias, target] of aliases) {
		if (isWithin(alias, path)) return target + path.slice(alias.length);
	}
	return path;
}

/**
 * Where an unmounted automount trigger would answer for `path`, or undefined when `path` is not under one. Decided from
 * the path text alone: the alias is replaced by its target and the longest mount point that contains the result owns
 * it, so a filesystem already mounted below the trigger (an NFS home under `/home`) keeps normal resolution.
 */
export function unmountedAutomountPath(path: string, view: MountView): string | undefined {
	const mapped = throughAlias(resolve(path), view.aliases);
	let owner: MountEntry | undefined;
	for (const entry of view.mounts) {
		if (!isWithin(entry.mountPoint, mapped)) continue;
		if (owner === undefined || entry.mountPoint.length > owner.mountPoint.length) owner = entry;
	}
	return owner?.type === "autofs" ? mapped : undefined;
}

async function rootAliases(roots: readonly string[]): Promise<Map<string, string>> {
	const aliases = new Map<string, string>();
	if (roots.length === 0) return aliases;
	try {
		for (const entry of await readdir(sep, { withFileTypes: true })) {
			if (!entry.isSymbolicLink()) continue;
			const alias = join(sep, entry.name);
			const link = await readlink(alias).catch(() => undefined);
			if (link === undefined) continue;
			const target = isAbsolute(link) ? resolve(link) : resolve(sep, link);
			if (roots.some((root) => isWithin(root, target))) aliases.set(alias, target);
		}
	} catch {
		return aliases;
	}
	return aliases;
}

async function readMountView(): Promise<MountView> {
	const mounts = await readMountTable();
	const roots = mounts.filter((entry) => entry.type === "autofs").map((entry) => entry.mountPoint);
	return { mounts, aliases: await rootAliases(roots) };
}

let cached: { readonly readAt: number; readonly view: Promise<MountView> } | undefined;

function currentMountView(): Promise<MountView> {
	const now = Date.now();
	if (cached === undefined || now - cached.readAt > MOUNT_VIEW_MAX_AGE_MS) {
		cached = { readAt: now, view: readMountView() };
	}
	return cached.view;
}

/**
 * The path text an unmounted automount trigger owns, or undefined for any other path.
 *
 * Opening a trigger whose automounter does not answer never returns, and on the runtime's shared filesystem pool an
 * abandoned call keeps its thread forever: enough of them and every asynchronous filesystem call in the process hangs
 * (senpi#7157). Such a path must therefore never reach `realpath` or any other filesystem call, and this check itself
 * reads only the mount table and the root directory's symlinks, never the path.
 */
export async function automountTriggerPath(path: string): Promise<string | undefined> {
	return unmountedAutomountPath(path, await currentMountView());
}
