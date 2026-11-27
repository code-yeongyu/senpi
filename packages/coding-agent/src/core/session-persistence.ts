/**
 * A session's persistence choice (`open_session.persistence`, senpi#7567): `none` is the per-session
 * `--no-session`. Such a session lives in memory only; nothing it does ever creates or extends a file, so it can
 * never be switched to, imported into, or persisted as one. Held on the launch profile, it follows the session
 * through a worker isolate and every replacement.
 */
export type SessionPersistence = "file" | "none";

const SESSION_NOT_PERSISTED = "session_not_persisted";

class SessionNotPersistedError extends Error {
	readonly code = SESSION_NOT_PERSISTED;

	constructor(operation: string) {
		super(`${SESSION_NOT_PERSISTED}: this session was opened with persistence "none" and cannot ${operation}`);
		this.name = "SessionNotPersistedError";
	}
}

/** Detail for an `open_session.persistence` the host refuses, or undefined when it is absent or known. */
export function sessionPersistenceError(value: unknown): string | undefined {
	if (value === undefined || value === "file" || value === "none") return undefined;
	return `persistence must be "file" or "none".`;
}

export function assertSessionPersistable(
	profile: { readonly persistence?: SessionPersistence } | undefined,
	operation: string,
): void {
	if (profile?.persistence === "none") throw new SessionNotPersistedError(operation);
}
