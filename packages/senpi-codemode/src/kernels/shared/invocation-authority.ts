import type { CellPermissionState } from "../js/kernel-contract.ts";
import type { KernelToolsInvokeOptions } from "../js/kernel-tools-types.ts";

export interface InvocationSession {
	readonly cwd: string;
	readonly state: CellPermissionState;
}

export interface InvocationPermissions {
	readonly state: () => CellPermissionState;
	/** Integration resolves live permission state even for an invoker that has never opened a kernel. */
	readonly resolveSession?: (sessionId: string) => InvocationSession;
}

const sessions = new Map<string, Set<() => InvocationSession>>();

export function registerInvocationSession(sessionId: string, read: () => InvocationSession): () => void {
	let entries = sessions.get(sessionId);
	if (!entries) {
		entries = new Set();
		sessions.set(sessionId, entries);
	}
	entries.add(read);
	return () => {
		entries.delete(read);
		if (entries.size === 0) sessions.delete(sessionId);
	};
}

export function invocationSession(
	ownerId: string,
	owner: InvocationSession,
	options?: AbortSignal | KernelToolsInvokeOptions,
	resolveSession?: InvocationPermissions["resolveSession"],
): InvocationSession & { readonly sessionId: string } {
	const invokerId = options && !("aborted" in options) ? options.invoker?.sessionId : undefined;
	if (invokerId === undefined || invokerId === ownerId) return { sessionId: ownerId, ...owner };
	const registered = [...(sessions.get(invokerId) ?? [])].map((read) => read());
	const invoker = resolveSession?.(invokerId) ?? registered.find((session) => session.state.active) ?? registered[0];
	for (const [enforcingSessionId, state] of [
		[ownerId, owner.state],
		[invokerId, invoker?.state],
	] as const) {
		if (!state?.active) continue;
		const rule = state.rules[0];
		throw Object.assign(
			new Error(
				rule
					? `Cross-session kernel tool refused while session ${enforcingSessionId} enforces deny rules, including ${rule.permission} ${rule.pattern} (${rule.layer})`
					: "Cross-session kernel tool refused: permission authority unavailable",
			),
			{ code: "cell_permission_denied", reason: "cross_session_authority", enforcingSessionId, rule },
		);
	}
	return {
		sessionId: invokerId,
		...(invoker ?? { cwd: owner.cwd, state: { epoch: 0, active: false, rules: [] } }),
	};
}
