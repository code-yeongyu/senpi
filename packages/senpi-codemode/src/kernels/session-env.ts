/**
 * Session environment exposed to eval kernels and every child they spawn.
 *
 * Mirrors the shell-tool session environment contract in the senpi core
 * (`resolveSpawnContext` in `packages/coding-agent/src/core/tools/bash.ts` and
 * `docs/environment-variables.md`): the per-session `PI_*` variables are
 * deleted from the inherited environment first, then set from the active
 * session, so a stale inherited value never leaks into a kernel child. A child
 * spawned from an eval cell must see the same session environment a child
 * spawned from the bash tool sees.
 */
export const SESSION_ENVIRONMENT_KEYS = [
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
] as const;

/** Resolved per-session values for {@link SESSION_ENVIRONMENT_KEYS}; absent keys stay unset. */
export type SessionEnvironment = Readonly<Record<string, string>>;

/** Structural slice of `ExtensionContext` the session environment is resolved from. */
export interface SessionEnvironmentSource {
	readonly sessionManager: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
	};
	readonly model?: { readonly provider: string; readonly id: string } | undefined;
	readonly thinkingLevel?: string | undefined;
}

export function sessionEnvironmentFrom(source: SessionEnvironmentSource): SessionEnvironment {
	const env: Record<string, string> = {};
	env.PI_SESSION_ID = source.sessionManager.getSessionId();
	const sessionFile = source.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	const model = source.model;
	if (model) {
		env.PI_PROVIDER = model.provider;
		env.PI_MODEL = model.id;
	}
	if (source.thinkingLevel) env.PI_REASONING_LEVEL = source.thinkingLevel;
	return env;
}

/**
 * Merges a session environment over a base environment the way the bash tool
 * does: every {@link SESSION_ENVIRONMENT_KEYS} entry is dropped from `base`
 * first, then the provided session values are applied.
 */
export function applySessionEnvironment(base: NodeJS.ProcessEnv, sessionEnv?: SessionEnvironment): NodeJS.ProcessEnv {
	const merged: NodeJS.ProcessEnv = { ...base };
	for (const key of SESSION_ENVIRONMENT_KEYS) delete merged[key];
	return { ...merged, ...sessionEnv };
}
