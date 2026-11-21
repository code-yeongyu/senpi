/**
 * The queued input a bundle already at a move's place records (senpi#6454, senpi#6566). An export sent without a list
 * carries it, so exporting a move again never erases input a release took out. That bundle may hold less than a
 * whole manifest: an export that failed after the seal keeps only its format, move id and input, which the
 * receiver's parser (`readManifest`) refuses. So this reads those three alone.
 *
 * One rule: only "no manifest there" means none. A manifest that is there and cannot be read or understood fails the
 * export, because the bundle that replaces it would erase what it records.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_FILE, MOVE_BUNDLE_FORMAT } from "./bundle.ts";

class KeptBundleUnreadableError extends Error {
	constructor(bundleDir: string, why: string) {
		super(
			`The bundle kept for this move (${bundleDir}) could not be read (${why}), so the move was not exported again: the new bundle would replace it and lose the queued input it records. Nothing was changed.`,
		);
		this.name = "KeptBundleUnreadableError";
	}
}

/**
 * `undefined` when no manifest is at the bundle's place; the input it lists when it is this move's; no input when it
 * is another move's. Throws when a manifest is there and cannot be read or understood.
 */
export async function keptQueuedInput(bundleDir: string, moveId: string): Promise<string[] | undefined> {
	let text: string;
	try {
		text = await readFile(join(bundleDir, MANIFEST_FILE), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new KeptBundleUnreadableError(bundleDir, error instanceof Error ? error.message : String(error));
	}
	let kept: unknown;
	try {
		kept = JSON.parse(text);
	} catch {
		throw new KeptBundleUnreadableError(bundleDir, "its manifest is not JSON");
	}
	if (typeof kept !== "object" || kept === null || !("format" in kept) || kept.format !== MOVE_BUNDLE_FORMAT)
		throw new KeptBundleUnreadableError(bundleDir, "its manifest is not one this version writes");
	if (!("moveId" in kept) || kept.moveId !== moveId) return [];
	const input = "droppedUserMessages" in kept ? kept.droppedUserMessages : undefined;
	if (!Array.isArray(input) || !input.every((message): message is string => typeof message === "string"))
		throw new KeptBundleUnreadableError(bundleDir, "its manifest does not list its queued input");
	return [...input];
}
