/**
 * macOS: the user's Trash through the OS API, `-[NSFileManager trashItemAtURL:resultingItemURL:error:]`, called
 * from JavaScript for Automation. Unlike a Finder AppleScript it needs no automation permission, and the OS
 * picks the trash of the item's own volume; when it cannot trash the item it fails instead of deleting it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TrashError } from "./trash-error.ts";

const TRASH_ITEM_SCRIPT = `ObjC.import("Foundation");
function run(argv) {
	const resulting = Ref();
	const error = Ref();
	const url = $.NSURL.fileURLWithPath(argv[0]);
	if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, resulting, error)) {
		throw new Error(ObjC.unwrap(error[0].localizedDescription));
	}
	return ObjC.unwrap(resulting[0].path);
}`;

export async function moveToMacTrash(target: string): Promise<string> {
	try {
		const { stdout } = await promisify(execFile)("osascript", ["-l", "JavaScript", "-e", TRASH_ITEM_SCRIPT, target], {
			encoding: "utf8",
		});
		const trashedPath = stdout.trim();
		if (trashedPath.length === 0) throw new Error("the OS reported no trashed location");
		return trashedPath;
	} catch (error) {
		const detail = error instanceof Error ? error.message.trim() : String(error);
		throw new TrashError("no_trash", `macOS could not move ${target} to the Trash; nothing was deleted. ${detail}`);
	}
}
