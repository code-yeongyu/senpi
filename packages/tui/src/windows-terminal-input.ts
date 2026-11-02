import { isMultiplexerSession } from "./mux.ts";

const CTRL_J_SEQUENCE = "\x1b[106;5u";
const WINDOWS_TERMINAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Windows Terminal forwards its `WT_SESSION` GUID into WSL. A terminal launched from it inherits the GUID but
 * names itself in `TERM_PROGRAM`, and over SSH or a multiplexer the client terminal may differ.
 */
export function isWindowsTerminalSession(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32" && platform !== "linux") return false;
	if (!WINDOWS_TERMINAL_SESSION_ID.test(env.WT_SESSION?.trim() ?? "")) return false;
	if (env.TERM_PROGRAM?.trim()) return false;
	if (isMultiplexerSession(env)) return false;
	return !(env.SSH_CONNECTION?.trim() || env.SSH_CLIENT?.trim() || env.SSH_TTY?.trim());
}

/** Windows Terminal sends CR for Enter, so a standalone LF there is Ctrl+J, never Enter (senpi#611). */
export function normalizeWindowsTerminalCtrlJInput(
	data: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return data === "\n" && isWindowsTerminalSession(env, platform) ? CTRL_J_SEQUENCE : data;
}
