/**
 * The folder an export writes its bundle to, and what it may already hold there: the input an earlier export of the
 * move kept when it failed after the session was sealed (senpi#6542), or an earlier export's whole bundle. The sender
 * reads that place to put the queued input back, so it must never be left without a manifest (senpi#6566's review).
 */
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../tools/path-utils.ts";
import { MANIFEST_FILE, readKeptBundle } from "./bundle.ts";

/**
 * The queued input this export carries. A call that sends none, as a caller that restarted after a failed export does,
 * carries what is kept at the place for this move; a call that sends a list carries that list.
 */
export async function queuedInputToCarry(
	bundleDir: string,
	moveId: string,
	sent: readonly string[],
): Promise<string[]> {
	if (sent.length > 0 || !(await pathExists(bundleDir))) return [...sent];
	const kept = await readKeptBundle(bundleDir).catch(() => undefined);
	return kept?.moveId === moveId ? [...kept.droppedUserMessages] : [];
}

/**
 * Puts a staged bundle at its place. A folder cannot be renamed over one that holds files, so when the place is taken
 * its other entries are removed and the staged ones moved in, and its manifest is replaced last, by one rename over
 * it: at every step the place holds a manifest, the earlier one until the new one replaces it.
 */
export async function putAtPlace(staged: string, bundleDir: string): Promise<void> {
	if (!(await pathExists(bundleDir))) {
		await rename(staged, bundleDir);
		return;
	}
	for (const entry of await readdir(bundleDir))
		if (entry !== MANIFEST_FILE) await rm(join(bundleDir, entry), { recursive: true, force: true });
	for (const entry of await readdir(staged))
		if (entry !== MANIFEST_FILE) await rename(join(staged, entry), join(bundleDir, entry));
	await rename(join(staged, MANIFEST_FILE), join(bundleDir, MANIFEST_FILE));
	await rm(staged, { recursive: true, force: true });
}
