import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionContext } from "../../types.ts";
import { NON_INTERACTIVE_MODES } from "./notify.ts";

/**
 * Per-session persistence dir for the terminal lease, manifest and monitor state dirs; undefined
 * when the context carries no durable session dir (SDK/in-memory sessions) or runs a one-shot
 * `print`/`json` turn, which has no later generation to restore into.
 */
export function terminalStateDir(ctx: ExtensionContext | undefined): string | undefined {
	if (ctx !== undefined && NON_INTERACTIVE_MODES.has(ctx.mode)) return undefined;
	const sessionDir = ctx?.sessionManager?.getSessionDir?.();
	if (sessionDir === undefined || sessionDir.length === 0 || !isAbsolute(sessionDir)) return undefined;
	return join(sessionDir, "extensions", "terminal");
}

export function monitorStateDir(terminalDir: string, monitorId: string): string {
	return join(terminalDir, "state", monitorId);
}

export async function ensureMonitorStateDir(terminalDir: string, monitorId: string): Promise<string> {
	const dir = monitorStateDir(terminalDir, monitorId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export async function removeMonitorStateDir(terminalDir: string, monitorId: string): Promise<void> {
	await rm(monitorStateDir(terminalDir, monitorId), { recursive: true, force: true });
}
