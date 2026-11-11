/**
 * The folder an `open_session` works in (senpi#6427). A folder the open names wins. An open that names none and
 * resumes a session file works where that file's header says, as the session manager and the CLI open it. It used to
 * take the host's own folder: a session reopened by its path alone ran its tools, and recorded its rules scan, in the
 * folder the host was started in. Only an open that creates the session, or a file whose header names no folder,
 * takes the host's default.
 *
 * The header's folder is returned as it is recorded. The registry maps a folder the desktop moved to where it lives
 * now (`resolveMovedProfile`) and refuses one that is not on this host (`assertSessionCwdExists`), exactly as it does
 * for a folder the open names: an open never falls back to the host's folder for a session that names another. Nor
 * does it fall back when it could not read the file or find it: an unreadable file and a probe that timed out refuse
 * the open, because falling back would open the session in the host's folder, which is the defect this closes.
 *
 * This runs on the host loop of both runtimes, so it does no synchronous file work: the moved-path probe is the
 * asynchronous, deadline-bounded one tool calls use, and only the header of the file is read.
 */
import { isAbsolute } from "node:path";
import { createMovedPathProbe } from "../../core/extensions/builtin/moved-path-guard/resolve-async.ts";
import { readHeaderCwd } from "../../core/session-header-cwd.ts";

export async function openSessionFolder(
	command: { readonly cwd?: string | null; readonly sessionPath?: string },
	hostDefault: string,
): Promise<string> {
	// `null` is what the profile already treats as "no folder named" (`command.cwd ?? host default`).
	if (command.cwd !== undefined && command.cwd !== null) return command.cwd;
	const { sessionPath } = command;
	if (typeof sessionPath !== "string" || !isAbsolute(sessionPath)) return hostDefault;
	// The registry opens an old spelling of a file the desktop moved where the file lives now, so its header is read there.
	const probe = createMovedPathProbe();
	const mapped = (await probe.resolve(sessionPath))?.mappedPath;
	if (probe.timedOut)
		throw new Error(
			`${sessionPath} could not be resolved: a filesystem step did not answer in time. Open it again, or name its folder with cwd.`,
		);
	// No file there yet: this open creates it, and nothing names a folder.
	const recorded = await readHeaderCwd(mapped ?? sessionPath);
	return recorded !== undefined && isAbsolute(recorded) ? recorded : hostDefault;
}
