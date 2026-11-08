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

const liveSessions = new Map<string, WeakRef<DecisionSession>>();

/**
 * Binds the remote approval-mode rule to one live session, evaluated at EACH gated decision:
 * 1. a preset a client named for the session wins (no override);
 * 2. a child (`spawnedBy`) follows its live parent's mode for the parent's current turn; a child whose parent is not
 *    live in this process asks, unless the operator named a preset for it with the launch flag;
 * 3. delegated-origin work asks, or uses the mode a client recorded in the session file when the operator named none;
 * 4. anything else keeps the host's own default (no override).
 */
export function bindDecisionPreset(session: DecisionSession): void {
	liveSessions.set(session.sessionManager.getSessionId(), new WeakRef(session));
	registerDecisionPresetOverride(session.sessionManager, () => decisionPreset(session));
}

function decisionPreset(session: DecisionSession): PermissionPresetName | undefined {
	if (session.namedPreset() !== undefined) return undefined;
	const parentId = session.sessionManager.getHeader()?.spawnedBy?.parentSessionId;
	if (parentId !== undefined) {
		const parent = liveSessions.get(parentId)?.deref();
		if (parent === undefined) return session.launchFlagNamed() ? undefined : "ask";
		const inherited = effectivePresetOf(parent);
		if (inherited !== undefined) return inherited;
	}
	return delegatedPreset(session);
}

function effectivePresetOf(session: DecisionSession): PermissionPresetName | undefined {
	const named = session.namedPreset();
	if (named !== undefined) return parsePermissionPresetName(named);
	return decisionPreset(session);
}

function delegatedPreset(session: DecisionSession): PermissionPresetName | undefined {
	if (!decidingTurnIsDelegated(session.sessionManager)) return undefined;
	if (session.launchFlagNamed()) return "ask";
	const recorded = session.recordedPreset();
	return (recorded === undefined ? undefined : parsePermissionPresetName(recorded)) ?? "ask";
}
