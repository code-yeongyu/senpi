import { readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { type AutomountHelperPoolOptions, createAutomountHelperPool } from "./automount-helper-pool.ts";
import { type AutomountRealpath, type AutomountRealpathOptions, realpathOutOfProcess } from "./automount-realpath.ts";
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
	const trigger = unmountedAutomount(path, view);
	return trigger === undefined ? undefined : join(trigger.mountPoint, ...trigger.below);
}

function unmountedAutomount(
	path: string,
	view: MountView,
): { readonly mountPoint: string; readonly below: readonly string[] } | undefined {
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
	return { mountPoint: owner.mountPoint, below: mapped.slice(ownerDepth) };
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

/**
 * The macOS automounter's default map (`/etc/auto_master`: `/home` through its root alias, `/net`, `/Network/Servers`),
 * answered by {@link automountTriggerPathSync} until the first mount-table read of the process lands.
 */
const DARWIN_DEFAULT_VIEW: MountView = {
	mounts: [
		{ mountPoint: "/", type: "apfs" },
		{ mountPoint: "/System/Volumes/Data/home", type: "autofs" },
		{ mountPoint: "/net", type: "autofs" },
		{ mountPoint: "/System/Volumes/Data/net", type: "autofs" },
		{ mountPoint: "/Network/Servers", type: "autofs" },
		{ mountPoint: "/System/Volumes/Data/Network/Servers", type: "autofs" },
	],
	aliases: new Map([["/home", "/System/Volumes/Data/home"]]),
	caseInsensitive: true,
};

interface ActiveTriggers {
	readonly lookup: AutomountTriggerLookup;
	readonly resolve: AutomountRealpathOptions;
	readonly helpers: ReturnType<typeof createAutomountHelperPool>;
	/** The view the latest finished read returned: what the synchronous check answers from. */
	settled: MountView | undefined;
	readonly fallback: MountView | undefined;
	/**
	 * Whether a lookup under an automount that does not answer blocks in the kernel (macOS): only there does the
	 * synchronous check refuse, and only there are resolver helpers bounded, since one stuck there may outlive its kill.
	 */
	readonly lookupsBlockInKernel: boolean;
}

/** What {@link answerAutomountTriggersFrom} may replace besides the view and the resolver. */
export interface AutomountTriggerBounds {
	readonly helpers?: AutomountHelperPoolOptions;
	/** The view the synchronous check answers from before the first read; defaults to the platform's default map. */
	readonly fallback?: MountView;
	/** The platform whose synchronous-check policy applies; defaults to this process's. */
	readonly platform?: NodeJS.Platform;
}

function activeFrom(
	readView: () => Promise<MountView>,
	resolve: AutomountRealpathOptions,
	bounds: AutomountTriggerBounds,
): ActiveTriggers {
	const platform = bounds.platform ?? process.platform;
	const state: ActiveTriggers = {
		lookup: createAutomountTriggerLookup(async () => {
			const view = await readView();
			state.settled = view;
			return view;
		}),
		resolve,
		helpers: createAutomountHelperPool(realpathOutOfProcess, bounds.helpers),
		settled: undefined,
		fallback: bounds.fallback ?? defaultTriggerView(platform),
		lookupsBlockInKernel: platform === "darwin",
	};
	return state;
}

/** The view {@link automountTriggerPathSync} answers from before the first read: the automounter's default map on macOS. */
export function defaultTriggerView(platform: NodeJS.Platform = process.platform): MountView | undefined {
	return platform === "darwin" ? DARWIN_DEFAULT_VIEW : undefined;
}

let active = activeFrom(readMountView, {}, {});

/**
 * Make {@link automountTriggerPath} answer from `readView` instead of the live mount table, and
 * {@link realpathUnderAutomount} resolve with `resolve` under `bounds` (helper limits, the synchronous check's
 * fallback view and platform), until the returned function restores the previous state. Tests use it to stand a temporary directory in for a trigger;
 * the live table cannot be written.
 */
export function answerAutomountTriggersFrom(
	readView: () => Promise<MountView>,
	resolve: AutomountRealpathOptions = {},
	bounds: AutomountTriggerBounds = {},
): () => void {
	const previous = active;
	active = activeFrom(readView, resolve, bounds);
	return () => {
		active = previous;
	};
}

/** Where a path under an automount trigger really leads, resolved outside this process ({@link realpathOutOfProcess}). */
export function realpathUnderAutomount(path: string): Promise<AutomountRealpath> {
	const state = active;
	if (!state.lookupsBlockInKernel) return realpathOutOfProcess(path, state.resolve);
	const view = state.settled ?? state.fallback;
	const trigger = view === undefined ? undefined : unmountedAutomount(path, view);
	// One automount answers for its mount point plus the first name below it (an auto_home user, a /net host).
	const key = trigger === undefined ? resolve(path) : join(trigger.mountPoint, ...trigger.below.slice(0, 1));
	return state.helpers(path, key, state.resolve);
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
	return active.lookup(path);
}

/**
 * {@link automountTriggerPath} for a caller that cannot wait: the host thread's synchronous path probes (senpi#4565).
 * A synchronous `lstat`/`stat`/`readdir`/`realpath` of a path under a trigger whose automounter does not answer never
 * returns and parks the whole process, so such a path must be answered "not on this machine" before any of them runs.
 *
 * Only macOS refuses: there a lookup under an automount whose automounter does not answer blocks in the kernel, and
 * `/home` is such a trigger by default. On Linux a lookup under an autofs mount point mounts it (an indirect `/home`,
 * `/net`, a systemd automount after its idle unmount), so a path there stays an ordinary path and nothing is refused.
 *
 * It answers from the view the latest finished read returned, and never waits or looks at the path itself. Before the
 * first read has finished it answers from the automounter's default map. A view older than the lookup's maximum age
 * starts a background re-read (macOS reads the table with `mount` in a child process), so a trigger that mounted since
 * stops being refused once that read lands.
 */
export function automountTriggerPathSync(path: string): string | undefined {
	const state = active;
	if (!state.lookupsBlockInKernel) return undefined;
	// The lookup re-reads the view only when its last read is stale, and the root is never under a trigger.
	state.lookup(sep).catch(() => undefined);
	const view = state.settled ?? state.fallback;
	return view === undefined ? undefined : unmountedAutomountPath(path, view);
}

/** The error code a synchronous probe refused by {@link refuseUnmountedAutomountPath} fails with. */
export const UNMOUNTED_AUTOMOUNT = "EAUTOMOUNT";

/**
 * Throw, as a filesystem call would, when `path` is under an unmounted automount trigger ({@link automountTriggerPathSync}):
 * the path names nothing on this machine, and the synchronous probe the caller was about to run could never return.
 */
export function refuseUnmountedAutomountPath(path: string): void {
	if (automountTriggerPathSync(path) === undefined) return;
	throw Object.assign(
		new Error(`${UNMOUNTED_AUTOMOUNT}: ${path} is under an automount that is not mounted on this machine`),
		{
			code: UNMOUNTED_AUTOMOUNT,
			path,
		},
	);
}
