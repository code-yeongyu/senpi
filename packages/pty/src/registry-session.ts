import type { SessionRegistrySession, TerminalSessionSignal } from "./registry-types.ts";

const DEFAULT_COMMAND = "bash";
export const DEFAULT_SIGNAL: TerminalSessionSignal = "SIGTERM";

export function sessionIdPrefix(command: string): string {
	const parts = command.split(/[\\/]/).filter(Boolean);
	const baseName = parts[parts.length - 1] ?? DEFAULT_COMMAND;
	const prefix = baseName
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
	const wait = session.waitExit ?? session.wait;
	if (!wait) return false;
	await wait();
	return isTerminalSessionExited(session);
}
