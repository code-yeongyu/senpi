import process from "node:process";
import { DEFAULT_SIGNAL, FORCE_SIGNAL } from "./registry-session.ts";
import type { SessionRegistrySession, TerminalSessionSignal, TrackedDetachedChild } from "./registry-types.ts";

/** How long a detached child may take to exit after SIGTERM before it is SIGKILLed. */
export const DEFAULT_DETACHED_EXIT_GRACE_MS = 1000;

export function getRuntimePlatform(): string {
	return process.platform;
}

export function defaultKillProcess(target: number, signal: TerminalSessionSignal): void {
	process.kill(target, signal);
}

/**
 * SIGTERM every tracked detached child, then — after a bounded grace — SIGKILL
 * the ones still alive. Without the escalation a child that ignores SIGTERM is
 * abandoned the moment the registry forgets its session.
 */
export async function cleanupDetachedChildren(
	session: SessionRegistrySession,
	platform: string,
	killProcess: (target: number, signal: TerminalSessionSignal) => void,
	exitGraceMs: number = DEFAULT_DETACHED_EXIT_GRACE_MS,
): Promise<void> {
	const signalled: TrackedDetachedChild[] = [];
	for (const child of getTrackedDetachedChildren(session)) {
		if (isTrackedDetachedChildExited(child)) continue;
		if (await signalDetachedChild(child, platform, killProcess, DEFAULT_SIGNAL)) signalled.push(child);
	}
	if (signalled.length === 0) return;

	if (exitGraceMs > 0) await delay(exitGraceMs);
	for (const child of signalled) {
		if (isTrackedDetachedChildExited(child)) continue;
		await signalDetachedChild(child, platform, killProcess, FORCE_SIGNAL);
	}
}

/** Returns whether the signal was actually delivered to a live child. */
async function signalDetachedChild(
	child: TrackedDetachedChild,
	platform: string,
	killProcess: (target: number, signal: TerminalSessionSignal) => void,
	signal: TerminalSessionSignal,
): Promise<boolean> {
	if (child.kill) {
		await child.kill(signal);
		return true;
	}
	const target = getDetachedChildKillTarget(child, platform);
	if (target === null) return false;
	try {
		killProcess(target, signal);
	} catch (error) {
		if (!isMissingProcessError(error)) throw error;
		// ESRCH: the process (or group) is already gone — nothing left to escalate.
		return false;
	}
	return true;
}

async function delay(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
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
