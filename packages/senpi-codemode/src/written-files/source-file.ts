/**
 * The one definition of a workspace source file (senpi#7232): a regular file inside the session workspace, outside
 * the excluded directories and the session's own artifacts directory, that the workspace does not ignore, at most
 * {@link SOURCE_FILE_MAX_BYTES} long, whose leading bytes are UTF-8 text. The workspace scan enforces the location, ignore and size parts; {@link isSourceText}
 * decides the text part from the first {@link SOURCE_FILE_SNIFF_BYTES} bytes.
 */
export const SOURCE_FILE_MAX_BYTES = 1024 * 1024;
export const SOURCE_FILE_SNIFF_BYTES = 8 * 1024;

/** Never source, whatever the workspace's ignore rules say. */
export function excludedDirectories(): readonly string[] {
	return [".git", "node_modules"];
}

/** Whether a workspace-relative POSIX path can name a source file; a trailing slash is git's nested-repository entry. */
export function isSourcePath(relativePath: string): boolean {
	if (relativePath === "" || relativePath.endsWith("/")) return false;
	const excluded = excludedDirectories();
	return relativePath.split("/").every((segment) => segment !== ".." && !excluded.includes(segment));
}

export function isSourceText(head: Uint8Array): boolean {
	if (head.includes(0)) return false;
	try {
		// Streaming mode keeps a multi-byte character cut by the sniff window from counting as invalid.
		new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
		return true;
	} catch {
		return false;
	}
}
