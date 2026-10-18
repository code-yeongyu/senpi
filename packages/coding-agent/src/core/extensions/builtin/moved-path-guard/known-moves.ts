import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { MovedBreadcrumb } from "./breadcrumb.ts";
import type { MovedPath } from "./breadcrumb-trust.ts";
import { currentPathPlatform, matchMovedPrefix, type PathPlatform } from "./path-match.ts";

const LEGACY_ROOT_NAMES = [".t3", ".omo-app"] as const;

/** The OmO desktop's legacy data roots (omo-desktop-app#1829), checked before any other path a call names. */
export const legacyRoots = (): string[] => LEGACY_ROOT_NAMES.map((name) => join(homedir(), name));

/** Whether `path` is, by text, a legacy data root directly under one of the user's home spellings. */
export const isLegacyRoot = (path: string, homes: readonly string[], platform: PathPlatform): boolean =>
	homes.some((home) =>
		LEGACY_ROOT_NAMES.some(
			(name) => matchMovedPrefix(path, join(home, name), [[]], platform)?.remainder.length === 0,
		),
	);

/** A trusted breadcrumb and the old root it was walked at (realpath'd), under every spelling the text checks match. */
interface KnownRoot {
	readonly root: string;
	readonly breadcrumb: MovedBreadcrumb;
}

const known = new Map<string, KnownRoot>();

/**
 * One (old root, listed prefix) of a trusted breadcrumb, keyed by what the breadcrumb says rather than by how the old
 * root was spelled, so a symlinked or `/var` vs `/private/var` spelling of one root shares one decision.
 */
export const prefixKey = (oldRoot: string, breadcrumb: MovedBreadcrumb, prefix: readonly string[]): string =>
	[basename(oldRoot).toLowerCase(), breadcrumb.homeId, breadcrumb.movedTo, prefix.join("/")].join("\0");

/** The (old root, listed prefix) keys a path lies under, by text, among breadcrumbs trusted so far. */
export function knownPrefixKeys(path: string, platform: PathPlatform = currentPathPlatform()): string[] {
	return [...known].flatMap(([spelling, { root, breadcrumb }]) => {
		const match = matchMovedPrefix(path, spelling, breadcrumb.moved, platform);
		return match ? [prefixKey(root, breadcrumb, match.prefix)] : [];
	});
}

const reusedDecisions = new Map<string, boolean>();

/** The last answer this process got to "does this listed prefix hold its own `.git`", by `prefixKey`. */
export function rememberReused(key: string, reused: boolean): void {
	reusedDecisions.set(key, reused);
}

export function rememberedReused(key: string): boolean | undefined {
	return reusedDecisions.get(key);
}

/**
 * Remembers a trusted breadcrumb under its old root as the walk found it (`root`, realpath'd), as the walk's caller
 * spelled it (`called`), and each of those re-spelled under every spelling of the user's home (`homes`: as
 * `os.homedir()` spells it and its realpath). Commands name `~/.t3/...`, so when `$HOME` or `~/.t3` itself is a
 * symlink the text fallback and the probe ranking would otherwise never match it (fifth review M-2, sixth review
 * MEDIUM-1). Every spelling keys its decisions by `root`, so a re-used answer the walk recorded applies to all of them.
 * The spellings come from the walk's own steps, so the text checks stay free of filesystem work.
 */
export function rememberTrustedBreadcrumb(
	root: string,
	called: string | undefined,
	breadcrumb: MovedBreadcrumb,
	homes: readonly string[],
	platform: PathPlatform,
): void {
	const spellings = new Set(called === undefined ? [root] : [root, called]);
	for (const spelling of [...spellings])
		for (const home of homes) {
			const under = matchMovedPrefix(spelling, home, [[]], platform);
			if (under) for (const other of homes) spellings.add(join(other, ...under.remainder));
		}
	for (const spelling of spellings) known.set(spelling, { root, breadcrumb });
}

export function looksMoved(path: string, platform: PathPlatform = currentPathPlatform()): boolean {
	return (
		legacyRoots().some((root) => matchMovedPrefix(path, root, [[]], platform)) ||
		[...known].some(([spelling, { breadcrumb }]) => matchMovedPrefix(path, spelling, breadcrumb.moved, platform))
	);
}

/**
 * The moved location of `path` by text alone, from breadcrumbs trusted earlier in this process (senpi#2898 re-review
 * M3): used only for paths past a call's probe budget or deadline, so it does no filesystem work. A prefix this
 * process last found re-used (its own `.git`) is skipped, as the caller skips prefixes its own probe found re-used, so
 * a re-used worktree is never refused this way, also when a breadcrumb read timed out before the `.git` step
 * (fifth review M-1).
 */
export function knownMove(path: string, platform: PathPlatform = currentPathPlatform()): MovedPath | undefined {
	for (const [oldRoot, { root, breadcrumb }] of known) {
		const match = matchMovedPrefix(path, oldRoot, breadcrumb.moved, platform);
		if (match && rememberedReused(prefixKey(root, breadcrumb, match.prefix)) !== true)
			return { oldRoot, movedTo: breadcrumb.movedTo, mappedPath: join(breadcrumb.movedTo, ...match.remainder) };
	}
	return undefined;
}
