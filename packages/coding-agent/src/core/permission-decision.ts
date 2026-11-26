import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";
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

/**
 * A live session's decision record as every engine copy in the realm sees it (omo#12965). It is built by the copy
 * that owns the session, so the record answers with that copy's own turn origin and settings; another copy only calls
 * it and validates the answer. `visitedIds` carries the sessions already on the chain, so a `spawnedBy` loop through
 * any number of copies ends.
 */
interface DecisionRecord {
	effectivePreset(visitedIds: readonly string[]): unknown;
}

/** Live decision sessions of every engine copy in this realm: `liveSessions` before omo#12965. */
interface DecisionSessions {
	/**
	 * Replaces the record bound under `id`. More than one binder can hold an id: a session is bound again by its runtime
	 * and on each preset change, a second session can be live on the same session file, and a closed session's dispose
	 * can still be pending when its file is reopened. The displaced binder's `release` then deletes nothing.
	 */
	bind(id: string, record: DecisionRecord): void;
	/** Deletes only when `record` is the one bound under `id`. */
	release(id: string, record: DecisionRecord): void;
	get(id: string): unknown;
}

const decisionSessions = realmRegistry(
	"@code-yeongyu/senpi/decision-sessions/v1",
	(): DecisionSessions => {
		const records = new Map<string, DecisionRecord>();
		return {
			bind: (id, record) => {
				records.set(id, record);
			},
			release: (id, record) => {
				if (records.get(id) === record) records.delete(id);
			},
			get: (id) => records.get(id),
		};
	},
	(value): value is DecisionSessions => hasFunctions(value, ["bind", "release", "get"]),
);
/** The record this copy bound for each session manager, so only this copy's binder releases it. */
const boundRecords = new WeakMap<DecisionSessionManager, DecisionRecord>();

/**
 * Binds the remote approval-mode rule to one live session, evaluated at EACH gated decision:
 * 1. a preset a client named for the session wins (no override);
 * 2. delegated-origin work asks, or uses the mode a client recorded in the session file when the operator named none.
 *    It is decided before any `spawnedBy` inheritance, because `spawnedBy` is a client-supplied claim: naming a
 *    parent, real or made up, can never take a remote device's turn off this rule;
 * 3. a child (`spawnedBy`) follows its live parent's mode for the parent's current turn; a child whose parent is not
 *    live in this process asks, unless the operator named a preset for it with the launch flag;
 * 4. anything else keeps the host's own default (no override).
 * The live parent may belong to any engine copy in this realm: the decision sessions are a realm registry.
 */
export function bindDecisionPreset(session: DecisionSession): void {
	const record: DecisionRecord = Object.freeze({
		effectivePreset: (visitedIds: readonly string[]) => effectivePresetOf(session, visitedIds),
	});
	boundRecords.set(session.sessionManager, record);
	decisionSessions.bind(session.sessionManager.getSessionId(), record);
	registerDecisionPresetOverride(session.sessionManager, () => decisionPreset(session, []));
}

export function releaseDecisionPreset(sessionManager: DecisionSessionManager): void {
	const record = boundRecords.get(sessionManager);
	if (record === undefined) return;
	boundRecords.delete(sessionManager);
	decisionSessions.release(sessionManager.getSessionId(), record);
}

function decisionPreset(session: DecisionSession, visitedIds: readonly string[]): PermissionPresetName | undefined {
	if (session.namedPreset() !== undefined) return undefined;
	if (decidingTurnIsDelegated(session.sessionManager)) return delegatedPreset(session);
	const parentId = session.sessionManager.getHeader()?.spawnedBy?.parentSessionId;
	if (parentId === undefined) return undefined;
	const parent = decisionSessions.get(parentId);
	if (parent === undefined) return session.launchFlagNamed() ? undefined : "ask";
	const ownId = session.sessionManager.getSessionId();
	// A `spawnedBy` loop (only a crafted session file can make one) has no parent to follow: it asks.
	if (parentId === ownId || visitedIds.includes(parentId)) return "ask";
	return parentPreset(parent, [...visitedIds, ownId]);
}

/**
 * Reads a parent's record, which another engine copy may have built: an unknown preset name (a newer copy's) or a
 * malformed record asks; `undefined` keeps the host's own default, as the parent itself does.
 */
function parentPreset(parent: unknown, visitedIds: readonly string[]): PermissionPresetName | undefined {
	const effectivePreset =
		typeof parent === "object" && parent !== null ? Reflect.get(parent, "effectivePreset") : undefined;
	if (typeof effectivePreset !== "function") return "ask";
	const preset: unknown = Reflect.apply(effectivePreset, parent, [visitedIds]);
	if (preset === undefined) return undefined;
	return (typeof preset === "string" ? parsePermissionPresetName(preset) : undefined) ?? "ask";
}

function effectivePresetOf(session: DecisionSession, visitedIds: readonly string[]): PermissionPresetName | undefined {
	const named = session.namedPreset();
	if (named !== undefined) return parsePermissionPresetName(named);
	return decisionPreset(session, visitedIds);
}

function delegatedPreset(session: DecisionSession): PermissionPresetName {
	if (session.launchFlagNamed()) return "ask";
	const recorded = session.recordedPreset();
	return (recorded === undefined ? undefined : parsePermissionPresetName(recorded)) ?? "ask";
}
