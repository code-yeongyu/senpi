import type { MonitorRegistry } from "../monitor-registry.ts";
import type { MonitorRegistration, TerminalManifestWriter } from "../terminal-manifest.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult } from "./context.ts";

const manifestWriters = new Map<string, TerminalManifestWriter>();
/**
 * Specs captured before a writer is bound (lazy persistence, or a generation waiting on a
 * foreign lease holder). Drained in order the moment the writer binds, so nothing the agent
 * registered is lost to timing. Bounded: past the cap the oldest spec is dropped.
 */
const pendingSpecs = new Map<string, MonitorRegistration[]>();
export const MAX_PENDING_MONITOR_SPECS = 32;

/** Bind the session's manifest writer so monitor tool calls can hand it specs captured at the call site. */
export function bindTerminalManifestWriter(sessionId: string, writer: TerminalManifestWriter): void {
	manifestWriters.set(sessionId, writer);
	const queued = pendingSpecs.get(sessionId);
	pendingSpecs.delete(sessionId);
	for (const registration of queued ?? []) void writer.recordRegister(registration);
}

export function unbindTerminalManifestWriter(sessionId: string): void {
	manifestWriters.delete(sessionId);
}

export function pendingDurableSpecCount(sessionId: string): number {
	let count = 0;
	for (const registration of pendingSpecs.get(sessionId) ?? []) if (registration.spec.persistent) count += 1;
	return count;
}

/** The durability session key for a tool context: the agent session id, when the context carries one. */
export function manifestSessionKey(ctx: TerminalToolContext): string | undefined {
	return ctx.getSessionContext?.()?.sessionManager?.getSessionId?.();
}

/**
 * Hand a spec captured at the monitor tool call site to the session's writer, or queue it until
 * one binds. The write is awaited: the tool result must not claim a watch before its manifest
 * entry exists on disk.
 */
export async function handMonitorSpec(
	sessionKey: string | undefined,
	registration: MonitorRegistration,
): Promise<void> {
	if (sessionKey === undefined) return;
	const writer = manifestWriters.get(sessionKey);
	if (writer) {
		await writer.recordRegister(registration);
		return;
	}
	const queue = pendingSpecs.get(sessionKey) ?? [];
	queue.push(registration);
	if (queue.length > MAX_PENDING_MONITOR_SPECS) queue.shift();
	pendingSpecs.set(sessionKey, queue);
}

/** Persist a durable file watch's baseline checkpoint through the writer's debounced path. */
export function handFileCheckpoint(
	sessionKey: string | undefined,
	monitorId: string,
	registry: MonitorRegistry,
	runtimeId: string,
): void {
	const writer = sessionKey === undefined ? undefined : manifestWriters.get(sessionKey);
	const checkpoint = registry.fileCheckpoint(runtimeId);
	if (writer && checkpoint) writer.scheduleCheckpoint(monitorId, checkpoint);
}

/**
 * Admission control for a durable create. There is no cap unless `terminal.maxDurableMonitors`
 * sets one; then refuse once the session already holds that many restart-surviving monitors,
 * counting both the bound writer's entries and the specs still queued for a writer. Checked
 * BEFORE any spawn or registry registration so a refused call leaves no PTY and no manifest
 * entry behind. A context with no session key persists nothing, so it has no durable
 * population to cap.
 */
export function durableAdmissionError(ctx: TerminalToolContext): TerminalToolResult | undefined {
	const limit = ctx.maxDurableMonitors ?? "unlimited";
	if (limit === "unlimited") return undefined;
	const sessionKey = manifestSessionKey(ctx);
	if (sessionKey === undefined) return undefined;
	const held = (manifestWriters.get(sessionKey)?.durableCount() ?? 0) + pendingDurableSpecCount(sessionKey);
	if (held < limit) return undefined;
	return errorResult(
		`Cannot start another persistent monitor: this session already holds ${limit} durable monitors, the limit set by terminal.maxDurableMonitors. Stop one with kill_bash first, or raise the setting.`,
	);
}
