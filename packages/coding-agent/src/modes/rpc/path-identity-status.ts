import type { PathIdentityResolver } from "../../core/extensions/builtin/permission-system/path-identity-host.ts";

const STATES = ["not_started", "ready", "unavailable"] as const;
type PathIdentityResolverState = (typeof STATES)[number];

/**
 * What `senpi host status` says about the path identity resolver: `not_started` until a worker has
 * published its first mount snapshot (the worker is spawned by the first path request), `ready` after
 * it, or `unavailable` with why the worker could not start.
 */
export interface PathIdentityResolverStatus {
	readonly state: PathIdentityResolverState;
	readonly detail: string | null;
}

export function pathIdentityResolverStatus(resolver: PathIdentityResolver): PathIdentityResolverStatus {
	const detail = resolver.unavailable;
	if (detail !== undefined) return { state: "unavailable", detail };
	return { state: resolver.snapshot === undefined ? "not_started" : "ready", detail: null };
}

function isState(value: unknown): value is PathIdentityResolverState {
	return STATES.some((state) => state === value);
}

export function parsePathIdentityResolverStatus(value: unknown): PathIdentityResolverStatus | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { state, detail } = value as { state?: unknown; detail?: unknown };
	if (!isState(state)) return undefined;
	return { state, detail: typeof detail === "string" ? detail : null };
}
