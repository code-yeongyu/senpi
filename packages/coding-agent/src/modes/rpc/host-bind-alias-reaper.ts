/**
 * Opportunistic GC of `senpi-bind-XXXXXX` alias directories a killed host left in the temp roots (senpi#5404 review
 * LOW 3). A long-path bind keeps its alias until the server closes, so a SIGKILLed or OOM-killed host cannot remove it
 * in-process. An alias is removed only when it belongs to this user, is a 0700 directory older than 60 s, holds
 * exactly its `d` link and its `.owner` record, and that record's process is provably dead. A missing bind
 * directory is never taken as proof: a live host whose bind directory was moved keeps its alias, because freeing the
 * name in a shared root would let another user re-create it and redirect that host's close-time unlink. An
 * unreadable owner identity counts as alive. Removal unlinks the two entries and then removes the directory, so it
 * never recurses and fails if anything else appeared. At most MAX_ALIASES_PER_ROOT names are examined per root.
 */
import { lstat, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ProcessIdentityUnreadableError, processMatchesPidFile } from "../../utils/process-identity.ts";
import { ALIAS_LINK, ALIAS_OWNER, ALIAS_PREFIX, bindAliasRoots } from "./host-socket-bind.ts";

const ALIAS_NAME = new RegExp(`^${ALIAS_PREFIX}[A-Za-z0-9]{6}$`);
const MIN_AGE_MS = 60_000;
const MAX_ALIASES_PER_ROOT = 64;

export async function reapOrphanedBindAliases(): Promise<void> {
	await Promise.all([...new Set(bindAliasRoots())].map((root) => reapOrphanedBindAliasesIn(root)));
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
	const contents = (await readdir(dir)).sort();
	if (contents.length !== 2 || contents[0] !== ALIAS_OWNER || contents[1] !== ALIAS_LINK) return;
	if (!(await lstat(join(dir, ALIAS_LINK))).isSymbolicLink()) return;
	if (!(await ownerIsDead(join(dir, ALIAS_OWNER)))) return;
	await unlink(join(dir, ALIAS_LINK));
	await unlink(join(dir, ALIAS_OWNER));
	await rmdir(dir);
}

async function ownerIsDead(file: string): Promise<boolean> {
	const owner: unknown = JSON.parse(await readFile(file, "utf8"));
	if (typeof owner !== "object" || owner === null) return false;
	const pid = Reflect.get(owner, "pid");
	const processStartTime = Reflect.get(owner, "processStartTime");
	if (typeof pid !== "number" || typeof processStartTime !== "string" || processStartTime.length === 0) return false;
	const alive = await processMatchesPidFile({ pid, processStartTime }).catch((error: unknown) => {
		if (error instanceof ProcessIdentityUnreadableError) return true;
		throw error;
	});
	return !alive;
}
