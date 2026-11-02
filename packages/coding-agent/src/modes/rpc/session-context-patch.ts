/**
 * `set_session_context`: a patch layer over the context a session was opened with.
 *
 * The open-time context stays frozen (it is what the session's extensions read as `pi.sessionContext`);
 * patches live in a separate overlay the host republishes on `list_sessions { include_workers: true }` and
 * on `session_status` for subscribers that asked for context. A `null` value removes the key from the
 * published view, including a key the open supplied. The host's own identity keys can never be patched.
 */
import type { SessionContext } from "../../core/extensions/types.ts";
import type { PublishedSessionContext } from "./session-status.ts";

export type SessionContextValue = string | number | boolean;
export type SessionContextOverlay = Readonly<Record<string, SessionContextValue | null>>;

export const SESSION_CONTEXT_PATCH_LIMITS = {
	keyPattern: /^[a-z][a-z0-9_]{0,63}$/,
	valueChars: 256,
	overlayBytes: 4_096,
} as const;

/**
 * Keys a client may never patch: the host's own stamps, and the lineage labels a
 * `childrenOf` subscription matches on. Lineage belongs to the frozen open-time context;
 * letting a patch rewrite it would let any attached client re-parent a session in every
 * supervisor's `childrenOf` view without the subscribers ever being told.
 */
export const RESERVED_SESSION_CONTEXT_KEYS: ReadonlySet<string> = new Set([
	"host_socket",
	"host_instance",
	"shard_key",
	"tree_key",
	"parent_session_id",
	"root_session_id",
]);

export interface ContextPatchRefusal {
	readonly reason: string;
	readonly action: string;
}

function refuse(reason: string, action: string): { readonly refusal: ContextPatchRefusal } {
	return { refusal: { reason, action } };
}

export function applyContextPatch(
	overlay: SessionContextOverlay | undefined,
	patch: unknown,
): { readonly overlay: SessionContextOverlay } | { readonly refusal: ContextPatchRefusal } {
	const shape =
		'send patch as an object of lowercase keys to string, number, boolean or null values, e.g. { "task_status": "running" }';
	if (typeof patch !== "object" || patch === null || Array.isArray(patch))
		return refuse("patch must be an object", shape);
	const entries = Object.entries(patch);
	if (entries.length === 0) return refuse("patch has no keys", shape);
	const merged: Record<string, SessionContextValue | null> = { ...overlay };
	for (const [key, value] of entries) {
		if (!SESSION_CONTEXT_PATCH_LIMITS.keyPattern.test(key))
			return refuse(
				`key "${key}" must match ${SESSION_CONTEXT_PATCH_LIMITS.keyPattern.source}`,
				"rename the key to lowercase letters, digits and underscores",
			);
		if (RESERVED_SESSION_CONTEXT_KEYS.has(key))
			return refuse(
				`key "${key}" is set by the host and cannot be patched`,
				"drop that key from the patch; the host keeps it current",
			);
		if (typeof value === "string" && value.length > SESSION_CONTEXT_PATCH_LIMITS.valueChars)
			return refuse(
				`value for "${key}" is ${value.length} characters, at most ${SESSION_CONTEXT_PATCH_LIMITS.valueChars} are accepted`,
				"shorten the value or store it elsewhere and publish a reference",
			);
		if (typeof value === "number" && !Number.isFinite(value))
			return refuse(`value for "${key}" must be a finite number`, shape);
		if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
			return refuse(`value for "${key}" must be a string, number, boolean or null`, shape);
		merged[key] = value;
	}
	const bytes = Buffer.byteLength(JSON.stringify(merged));
	if (bytes > SESSION_CONTEXT_PATCH_LIMITS.overlayBytes)
		return refuse(
			`patched context would be ${bytes} bytes, at most ${SESSION_CONTEXT_PATCH_LIMITS.overlayBytes} are accepted`,
			"remove keys with null or shorten values before adding more",
		);
	return { overlay: merged };
}

export function publishedSessionContext(
	base: SessionContext,
	overlay: SessionContextOverlay | undefined,
): PublishedSessionContext {
	if (overlay === undefined) return base;
	const published: Record<string, SessionContextValue> = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (value === null) delete published[key];
		else published[key] = value;
	}
	return published;
}
