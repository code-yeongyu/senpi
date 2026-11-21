import { readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { type MountEntry, readMountTable } from "./mount-table.ts";

const MOUNT_VIEW_MAX_AGE_MS = 60_000;

/**
 * The mount table plus each top-level symlink that names an automount root (macOS `/home` -> `/System/Volumes/Data/home`).
 * `caseInsensitive` compares names the way the volume does (macOS APFS ignores case and normalization).
 */
export interface MountView {
	readonly mounts: readonly MountEntry[];
	readonly aliases: ReadonlyMap<string, string>;
	readonly caseInsensitive: boolean;
}

const segmentsOf = (path: string): string[] => path.split(sep).filter((segment) => segment.length > 0);

/** How many segments of `path` `root` covers, or undefined when `path` is not `root` or below it. */
function depthWithin(root: string, path: readonly string[], caseInsensitive: boolean): number | undefined {
	const fold = (segment: string): string => (caseInsensitive ? segment.normalize("NFC").toLowerCase() : segment);
	const rootSegments = segmentsOf(root);
	if (rootSegments.length > path.length) return undefined;
	for (const [index, segment] of rootSegments.entries()) {
		if (fold(segment) !== fold(path[index] ?? "")) return undefined;
	}
	return rootSegments.length;
}

function throughAlias(path: readonly string[], view: MountView): readonly string[] {
	for (const [alias, target] of view.aliases) {
		const depth = depthWithin(alias, path, view.caseInsensitive);
		if (depth !== undefined) return [...segmentsOf(target), ...path.slice(depth)];
	}
	return path;
}

/**
 * Where an unmounted automount trigger would answer for `path`, or undefined when `path` is not under one. Decided from
 * the path text alone: the alias is replaced by its target and the deepest mount point that contains the result owns
 * it, so a filesystem already mounted below the trigger (an NFS home under `/home`) keeps normal resolution. A direct or
 * systemd automount mounts its filesystem over the autofs entry at the SAME mount point, so the path is a trigger path
 * only while every entry at that deepest point is autofs; the answer is spelled with the mount point's own case.
 */
export function unmountedAutomountPath(path: string, view: MountView): string | undefined {
	const mapped = throughAlias(segmentsOf(resolve(path)), view);
	let owners: MountEntry[] = [];
	let ownerDepth = -1;
	for (const entry of view.mounts) {
		const depth = depthWithin(entry.mountPoint, mapped, view.caseInsensitive);
		if (depth === undefined || depth < ownerDepth) continue;
		if (depth > ownerDepth) owners = [];
		ownerDepth = depth;
		owners.push(entry);
	}
	const [owner] = owners;
	if (owner === undefined || owners.some((entry) => entry.type !== "autofs")) return undefined;
	return join(owner.mountPoint, ...mapped.slice(ownerDepth));
}

async function rootAliases(roots: readonly string[], caseInsensitive: boolean): Promise<Map<string, string>> {
	const aliases = new Map<string, string>();
	if (roots.length === 0) return aliases;
	try {
		for (const entry of await readdir(sep, { withFileTypes: true })) {
			if (!entry.isSymbolicLink()) continue;
			const alias = join(sep, entry.name);
			const link = await readlink(alias).catch(() => undefined);
			if (link === undefined) continue;
			const target = isAbsolute(link) ? resolve(link) : resolve(sep, link);
			const targetSegments = segmentsOf(target);
			if (roots.some((root) => depthWithin(root, targetSegments, caseInsensitive) !== undefined)) {
				aliases.set(alias, target);
			}
		}
	} catch {
		return aliases;
	}
	return aliases;
}

async function readMountView(): Promise<MountView> {
	const mounts = await readMountTable();
	const roots = mounts.filter((entry) => entry.type === "autofs").map((entry) => entry.mountPoint);
	const caseInsensitive = process.platform === "darwin";
	return { mounts, aliases: await rootAliases(roots, caseInsensitive), caseInsensitive };
}

/** Answers like {@link automountTriggerPath}. */
export type AutomountTriggerLookup = (path: string) => Promise<string | undefined>;

/**
 * A trigger lookup over the views `readView` returns. Other paths are classified from a view up to a minute old. A
 * trigger answer skips symlink resolution, so it is never given from a view read before the call began: the automounter
 * may have mounted the path since, and then the policy must see its symlinks resolved. Such an answer re-reads the view,
 * sharing a read that began after the call did.
 */
export function createAutomountTriggerLookup(readView: () => Promise<MountView>): AutomountTriggerLookup {
	// `read` numbers the reads, so a call can tell a read that began after it did.
	let latest: { readonly read: number; readonly readAt: number; readonly view: Promise<MountView> } | undefined;
	const startRead = (): NonNullable<typeof latest> => {
		latest = { read: (latest?.read ?? 0) + 1, readAt: Date.now(), view: readView() };
		return latest;
	};
	return async (path) => {
		const before = latest?.read ?? 0;
		const current =
			latest !== undefined && Date.now() - latest.readAt <= MOUNT_VIEW_MAX_AGE_MS ? latest : startRead();
		const triggerPath = unmountedAutomountPath(path, await current.view);
		if (triggerPath === undefined || current.read > before) return triggerPath;
		const fresh = latest !== undefined && latest.read > before ? latest : startRead();
		return unmountedAutomountPath(path, await fresh.view);
	};
}

let lookup = createAutomountTriggerLookup(readMountView);

/**
 * Make {@link automountTriggerPath} answer from `readView` instead of the live mount table, until the returned function
 * restores it. Tests use it to stand a temporary directory in for a trigger; the live table cannot be written.
 */
export function answerAutomountTriggersFrom(readView: () => Promise<MountView>): () => void {
	const previous = lookup;
	lookup = createAutomountTriggerLookup(readView);
	return () => {
		lookup = previous;
	};
}

/**
 * The path text an unmounted automount trigger owns, or undefined for any other path.
 *
 * Opening a trigger whose automounter does not answer never returns, and on the runtime's shared filesystem pool an
 * abandoned call keeps its thread forever: enough of them and every asynchronous filesystem call in the process hangs
 * (senpi#7157). Such a path must therefore never reach `realpath` or any other filesystem call, and this check itself
 * reads only the mount table and the root directory's symlinks, never the path. The view is re-read before any trigger
 * answer ({@link createAutomountTriggerLookup}).
 */
export function automountTriggerPath(path: string): Promise<string | undefined> {
	return lookup(path);
}
