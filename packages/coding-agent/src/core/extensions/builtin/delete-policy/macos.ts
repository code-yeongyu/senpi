/**
 * macOS: the user's Trash through the system's own `/usr/bin/trash` (macOS 15 and later), which moves an item to the
 * Trash of its own volume and prints where it went with `-v`. A JavaScript for Automation call to `NSFileManager` was
 * tried first and crashes (exit 139) from a background session with no GUI login context, which is where an agent
 * runs (senpi#7578). The Trash cannot be listed from such a session (macOS privacy protection denies it), so the
 * trashed path is taken from the tool's own report, never found by scanning. When it cannot trash an item it fails
 * instead of deleting it.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { TrashError } from "./trash-error.ts";

export const MAC_TRASH_TOOL = "/usr/bin/trash";

/** `# Moved "<from>" to "<to>"`, with the home directory written as `~`. */
const MOVED = /^# Moved "(?:[^"\\]|\\.)*" to "((?:[^"\\]|\\.)*)"$/m;

export function trashedPathFromReport(report: string, home: string): string | undefined {
	const reported = MOVED.exec(report)?.[1];
	if (reported === undefined) return undefined;
	return reported.startsWith("~/") ? `${home}${reported.slice(1)}` : reported;
}

export async function moveToMacTrash(target: string, tool = MAC_TRASH_TOOL): Promise<string> {
	if (!existsSync(tool)) {
		throw new TrashError(
			"no_trash",
			`${tool} is not available on this macOS; ${target} was not moved and nothing was deleted.`,
		);
	}
	try {
		// The first call from a background session waits about 35 s for the Trash service, so no short timeout here.
		const { stdout, stderr } = await promisify(execFile)(tool, ["-v", target], { encoding: "utf8" });
		const trashedPath = trashedPathFromReport(`${stdout}\n${stderr}`, homedir());
		if (trashedPath === undefined) throw new Error("the OS reported no trashed location");
		return trashedPath;
	} catch (error) {
		const detail = error instanceof Error ? error.message.trim() : String(error);
		throw new TrashError("no_trash", `macOS could not move ${target} to the Trash; nothing was deleted. ${detail}`);
	}
}
