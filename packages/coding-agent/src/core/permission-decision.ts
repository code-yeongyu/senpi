import { parsePermissionPresetName } from "./extensions/builtin/permission-system/cli.ts";
import { registerDecisionPresetOverride } from "./extensions/builtin/permission-system/preset-registry.ts";
import type { PermissionPresetName } from "./extensions/builtin/permission-system/types.ts";
import type { SessionManager } from "./session-manager.ts";
import { decidingTurnIsDelegated } from "./turn-origin.ts";

type DecisionSessionManager = Pick<SessionManager, "getEntries" | "getHeader" | "getSessionId">;

export interface DecisionSession {
	readonly sessionManager: DecisionSessionManager;
	readonly namedPreset: () => string | undefined;
	readonly launchFlagNamed: () => boolean;
	readonly recordedPreset: () => string | undefined;
}

const liveSessions = new Map<string, DecisionSession>();

/**
 * Binds the remote approval-mode rule to one live session, evaluated at EACH gated decision:
 * 1. a preset a client named for the session wins (no override);
 * 2. delegated-origin work asks, or uses the mode a client recorded in the session file when the operator named none.
 *    It is decided before any `spawnedBy` inheritance, because `spawnedBy` is a client-supplied claim: naming a
 *    parent, real or made up, can never take a remote device's turn off this rule;
 * 3. a child (`spawnedBy`) follows its live parent's mode for the parent's current turn; a child whose parent is not
 *    live in this process asks, unless the operator named a preset for it with the launch flag;
 * 4. anything else keeps the host's own default (no override).
 */
export function bindDecisionPreset(session: DecisionSession): void {
	liveSessions.set(session.sessionManager.getSessionId(), session);
	registerDecisionPresetOverride(session.sessionManager, () => decisionPreset(session, new Set()));
}

export function releaseDecisionPreset(sessionManager: DecisionSessionManager): void {
	const id = sessionManager.getSessionId();
	if (liveSessions.get(id)?.sessionManager === sessionManager) liveSessions.delete(id);
}

function decisionPreset(session: DecisionSession, visited: Set<DecisionSession>): PermissionPresetName | undefined {
	if (session.namedPreset() !== undefined) return undefined;
	if (decidingTurnIsDelegated(session.sessionManager)) return delegatedPreset(session);
	const parentId = session.sessionManager.getHeader()?.spawnedBy?.parentSessionId;
	if (parentId === undefined) return undefined;
	const parent = liveSessions.get(parentId);
	if (parent === undefined) return session.launchFlagNamed() ? undefined : "ask";
	// A `spawnedBy` loop (only a crafted session file can make one) has no parent to follow: it asks.
	if (visited.has(parent) || parent === session) return "ask";
	visited.add(session);
	return effectivePresetOf(parent, visited);
}

function effectivePresetOf(session: DecisionSession, visited: Set<DecisionSession>): PermissionPresetName | undefined {
	const named = session.namedPreset();
	if (named !== undefined) return parsePermissionPresetName(named);
	return decisionPreset(session, visited);
}

function delegatedPreset(session: DecisionSession): PermissionPresetName {
	if (session.launchFlagNamed()) return "ask";
	const recorded = session.recordedPreset();
	return (recorded === undefined ? undefined : parsePermissionPresetName(recorded)) ?? "ask";
}
