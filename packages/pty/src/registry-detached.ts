import process from "node:process";
import { DEFAULT_SIGNAL } from "./registry-session.ts";
import type { SessionRegistrySession, TerminalSessionSignal, TrackedDetachedChild } from "./registry-types.ts";

export function getRuntimePlatform(): string {
	return process.platform;
}

export function defaultKillProcess(target: number, signal: TerminalSessionSignal): void {
	process.kill(target, signal);
}

export async function cleanupDetachedChildren(
	session: SessionRegistrySession,
	platform: string,
	killProcess: (target: number, signal: TerminalSessionSignal) => void,
): Promise<void> {
	for (const child of getTrackedDetachedChildren(session)) {
		if (isTrackedDetachedChildExited(child)) continue;
		if (child.kill) {
			await child.kill(DEFAULT_SIGNAL);
			continue;
		}
		const target = getDetachedChildKillTarget(child, platform);
		if (target === null) continue;
		try {
			killProcess(target, DEFAULT_SIGNAL);
		} catch (error) {
			if (!isMissingProcessError(error)) throw error;
		}
	}
}

function getTrackedDetachedChildren(session: SessionRegistrySession): readonly TrackedDetachedChild[] {
	return session.getTrackedDetachedChildren?.() ?? session.trackedDetachedChildren ?? [];
}

function isTrackedDetachedChildExited(child: TrackedDetachedChild): boolean {
	if (typeof child.exited === "boolean") return child.exited;
	if (typeof child.exited === "function") return child.exited();
	return false;
}

function getDetachedChildKillTarget(child: TrackedDetachedChild, platform: string): number | null {
	if (platform !== "win32" && isPositiveInteger(child.processGroupId)) return -child.processGroupId;
	if (isPositiveInteger(child.pid)) return child.pid;
	return null;
}

function isPositiveInteger(value: number | undefined): value is number {
	return value !== undefined && Number.isInteger(value) && value > 0;
}

function isMissingProcessError(error: unknown): boolean {
	if (!isRecord(error)) return false;
	return error.code === "ESRCH";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}
