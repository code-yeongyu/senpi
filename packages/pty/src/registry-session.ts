import type { SessionRegistrySession, TerminalSessionSignal } from "./registry-types.ts";

const DEFAULT_COMMAND = "bash";
export const DEFAULT_SIGNAL: TerminalSessionSignal = "SIGTERM";

export function sessionIdPrefix(command: string): string {
	const parts = command.split(/[\\/]/).filter(Boolean);
	const baseName = parts[parts.length - 1] ?? DEFAULT_COMMAND;
	// Strip a Windows executable extension first so `bash.exe` collapses to the same
	// `bash` prefix as POSIX `/bin/bash`; otherwise the `.exe` sanitizes to `_exe` and
	// session ids become `bash_exe_1`, breaking the cross-platform `bash_N` scheme.
	const withoutExt = baseName.replace(/\.(?:exe|com|bat|cmd|ps1)$/i, "");
	const prefix = withoutExt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return prefix || "session";
}

export function isTerminalSessionExited(session: SessionRegistrySession): boolean {
	if (session.exited === true) return true;
	if (typeof session.isExited === "boolean") return session.isExited;
	if (typeof session.isExited === "function" && session.isExited()) return true;
	if (session.exitState?.status === "exited") return true;
	if (session.status === "exited" || session.status === "closed" || session.status === "stopped") return true;
	return session.exitResult !== undefined && session.exitResult !== null;
}

export async function stopTerminalSession(session: SessionRegistrySession): Promise<void> {
	// Call through `session` so class methods keep their `this` binding.
	if (session.stop) {
		await session.stop();
		return;
	}
	if (session.kill) {
		await session.kill(DEFAULT_SIGNAL);
		return;
	}
	if (session.signal) await session.signal(DEFAULT_SIGNAL);
}

export async function waitForTerminalSessionExit(session: SessionRegistrySession): Promise<boolean> {
	if (isTerminalSessionExited(session)) return true;
	// Invoke via the session object (not a detached reference) so `this` is preserved.
	if (session.waitExit) await session.waitExit();
	else if (session.wait) await session.wait();
	else return false;
	return isTerminalSessionExited(session);
}
