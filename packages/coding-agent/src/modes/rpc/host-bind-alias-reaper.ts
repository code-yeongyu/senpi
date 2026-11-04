/**
 * Opportunistic GC of `senpi-bind-XXXXXX` alias directories a killed host left in the temp roots (senpi#5404 review
 * LOW 3). A long-path bind keeps its alias until the server closes, so a SIGKILLed or OOM-killed host cannot remove it
 * in-process. An alias is removed only when it belongs to this user, is a 0700 directory older than 60 s, holds
 * nothing but its `d` link, and that link's target (the host's `<endpoint>.bind-<hex>` directory) no longer exists.
 * A live host keeps its bind directory until it closes, so its alias is never touched; a dead host's bind directory
 * goes when `host gc` reclaims the endpoint, and its alias on the next pass after that. `rm` removes the link itself,
 * never what it points at. At most MAX_ALIASES_PER_ROOT candidates are examined per root per pass.
 */
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ALIAS_LINK, ALIAS_PREFIX, bindAliasRoots } from "./host-socket-bind.ts";

const ALIAS_NAME = new RegExp(`^${ALIAS_PREFIX}[A-Za-z0-9]{6}$`);
const MIN_AGE_MS = 60_000;
const MAX_ALIASES_PER_ROOT = 64;

export async function reapOrphanedBindAliases(): Promise<void> {
	await Promise.all(bindAliasRoots().map((root) => reapOrphanedBindAliasesIn(root)));
}

export async function reapOrphanedBindAliasesIn(root: string): Promise<void> {
	const names = await readdir(root).catch(() => [] as string[]);
	const candidates = names.filter((name) => ALIAS_NAME.test(name)).slice(0, MAX_ALIASES_PER_ROOT);
	await Promise.all(candidates.map((name) => reapIfOrphaned(join(root, name)).catch(() => undefined)));
}

async function reapIfOrphaned(dir: string): Promise<void> {
	const entry = await lstat(dir);
	const self = process.getuid?.();
	if (!entry.isDirectory() || (self !== undefined && entry.uid !== self)) return;
	if ((entry.mode & 0o777) !== 0o700 || entry.mtimeMs > Date.now() - MIN_AGE_MS) return;
	const contents = await readdir(dir);
	if (contents.length !== 1 || contents[0] !== ALIAS_LINK) return;
	const link = join(dir, ALIAS_LINK);
	if (!(await lstat(link)).isSymbolicLink()) return;
	if (await targetExists(link)) return;
	await rm(dir, { recursive: true, force: true });
}

async function targetExists(link: string): Promise<boolean> {
	try {
		await stat(link);
		return true;
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
		return true;
	}
}
