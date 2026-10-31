export type UserActivityKind = "draft" | "prompt";

/** Only the owning AgentSession receives the emitter; extensions can only subscribe. */
export function createUserActivitySource() {
	const listeners = new Set<(kind: UserActivityKind) => void>();
	return {
		emit(kind: UserActivityKind): void {
			for (const listener of listeners) listener(kind);
		},
		subscribe(listener: (kind: UserActivityKind) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export function emitUserActivity(
	session: { recordUserActivity?(kind: UserActivityKind): void } | undefined,
	kind: UserActivityKind,
): void {
	session?.recordUserActivity?.(kind);
}
