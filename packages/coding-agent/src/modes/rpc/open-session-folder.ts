/**
 * The folder an `open_session` works in (senpi#6427). A folder the open names wins. An open that names none and
 * resumes a session file works where that file's header says, as the session manager and the CLI open it. It used to
 * take the host's own folder: a session reopened by its path alone ran its tools, and recorded its rules scan, in the
 * folder the host was started in. Only an open that creates the session, or a file whose header names no folder,
 * takes the host's default.
 *
 * The header's folder is returned as it is recorded. The registry maps a folder the desktop moved to where it lives
 * now (`resolveMovedProfile`) and refuses one that is not on this host (`assertSessionCwdExists`), exactly as it does
 * for a folder the open names: an open never falls back to the host's folder for a session that names another.
 *
 * This runs on the host loop of both runtimes, so it does no synchronous file work: the moved-path probe is the
 * asynchronous, deadline-bounded one tool calls use, and only the header line of the file is read.
 */
import { isAbsolute } from "node:path";
import { createMovedPathProbe } from "../../core/extensions/builtin/moved-path-guard/resolve-async.ts";
import { readSessionCwd } from "../../core/session-rebind.ts";

export async function openSessionFolder(
	command: { readonly cwd?: string; readonly sessionPath?: string },
	hostDefault: string,
): Promise<string> {
	if (command.cwd !== undefined) return command.cwd;
	const { sessionPath } = command;
	if (typeof sessionPath !== "string" || !isAbsolute(sessionPath)) return hostDefault;
	// The registry opens an old spelling of a file the desktop moved where the file lives now, so its header is read there.
	const file = (await createMovedPathProbe().resolve(sessionPath))?.mappedPath ?? sessionPath;
	// No file there yet (this open creates it), or no readable header: no folder is named, and the open itself reports
	// whatever is wrong with the file.
	const recorded = await readSessionCwd(file).catch(() => undefined);
	return recorded !== undefined && isAbsolute(recorded) ? recorded : hostDefault;
}
