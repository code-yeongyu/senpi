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
 * does it fall back when it could not read the file: an unreadable file refuses the open, because falling back would
 * open the session in the host's folder, which is the defect this closes. A probe whose step timed out (a loaded host,
 * a slow mount) has not answered where the file lives, so the file is found the way the registry then opens it
 * (`resolveMovedPath`, the same walk without per-step deadlines) instead of refusing the open (senpi#7385).
 *
 * This runs on the host loop of both runtimes, so it starts with the asynchronous, deadline-bounded probe tool calls use;
 * only when that probe timed out does it take the registry's synchronous walk, which the same open runs next anyway.
 */
import { isAbsolute } from "node:path";
import { resolveMovedPath } from "../../core/extensions/builtin/moved-path-guard/resolve.ts";
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
	const probed = (await probe.resolve(sessionPath))?.mappedPath;
	const mapped = probe.timedOut ? resolveMovedPath(sessionPath) : (probed ?? sessionPath);
	// No file there yet: this open creates it, and nothing names a folder.
	const recorded = await readHeaderCwd(mapped);
	return recorded !== undefined && isAbsolute(recorded) ? recorded : hostDefault;
}
