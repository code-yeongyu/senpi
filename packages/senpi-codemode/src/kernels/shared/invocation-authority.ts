import type { CellPermissionState } from "../js/kernel-contract.ts";
import type { KernelToolsInvokeOptions } from "../js/kernel-tools-types.ts";
import { cellAuthority } from "./cell-authority-registry.ts";

export interface InvocationSession {
	readonly cwd: string;
	readonly state: CellPermissionState;
}

export interface InvocationPermissions {
	readonly state: () => CellPermissionState;
	/** Integration resolves live permission state even for an invoker that has never opened a kernel. */
	readonly resolveSession?: (sessionId: string) => InvocationSession;
}

/** Registers what this session's kernel reports, for every codemode copy in the realm (omo#12965). */
export function registerInvocationSession(sessionId: string, read: () => InvocationSession): () => void {
	return cellAuthority.registerInvocation(sessionId, read);
}

function isCellRule(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		["permission", "pattern", "layer"].every((name) => typeof Reflect.get(value, name) === "string")
	);
}

/** A snapshot another copy's kernel may have produced: every field present with its type. */
function isInvocationSession(value: unknown): value is InvocationSession {
	if (typeof value !== "object" || value === null || typeof Reflect.get(value, "cwd") !== "string") return false;
	const state: unknown = Reflect.get(value, "state");
	if (typeof state !== "object" || state === null) return false;
	const rules: unknown = Reflect.get(state, "rules");
	return (
		typeof Reflect.get(state, "epoch") === "number" &&
		typeof Reflect.get(state, "active") === "boolean" &&
		Array.isArray(rules) &&
		rules.every(isCellRule)
	);
}

function crossSessionRefusal(enforcingSessionId: string, rule?: CellPermissionState["rules"][number]): Error {
	return Object.assign(
		new Error(
			rule
				? `Cross-session kernel tool refused while session ${enforcingSessionId} enforces deny rules, including ${rule.permission} ${rule.pattern} (${rule.layer})`
				: "Cross-session kernel tool refused: permission authority unavailable",
		),
		{ code: "cell_permission_denied", reason: "cross_session_authority", enforcingSessionId, rule },
	);
}

/**
 * What the invoker's kernels report, from whichever copy registered them. A snapshot this copy cannot read refuses:
 * an invoker whose deny state is not visible is never treated as having none.
 */
function registeredInvocationSessions(invokerId: string): InvocationSession[] {
	const snapshots: unknown = cellAuthority.invocations(invokerId);
	if (!Array.isArray(snapshots)) throw crossSessionRefusal(invokerId);
	return snapshots.map((snapshot: unknown) => {
		if (!isInvocationSession(snapshot)) throw crossSessionRefusal(invokerId);
		return snapshot;
	});
}

export function invocationSession(
	ownerId: string,
	owner: InvocationSession,
	options?: AbortSignal | KernelToolsInvokeOptions,
	resolveSession?: InvocationPermissions["resolveSession"],
): InvocationSession & { readonly sessionId: string } {
	const invokerId = options && !("aborted" in options) ? options.invoker?.sessionId : undefined;
	if (invokerId === undefined || invokerId === ownerId) return { sessionId: ownerId, ...owner };
	// The hook answers only with a session: `undefined` or `null` is no answer, and the registered kernels decide.
	const resolved = resolveSession?.(invokerId) ?? undefined;
	const registered = resolved === undefined ? registeredInvocationSessions(invokerId) : [];
	const invoker = resolved ?? registered.find((session) => session.state.active) ?? registered[0];
	for (const [enforcingSessionId, state] of [
		[ownerId, owner.state],
		[invokerId, invoker?.state],
	] as const) {
		if (state?.active) throw crossSessionRefusal(enforcingSessionId, state.rules[0]);
	}
	return invoker
		? { sessionId: invokerId, cwd: invoker.cwd, state: invoker.state }
		: { sessionId: invokerId, cwd: owner.cwd, state: { epoch: 0, active: false, rules: [] } };
}
