/**
 * Resolve a `{file:<path>}` config placeholder to the contents of that file.
 *
 * Shared by the two places the engine resolves config values when it loads
 * them: provider API keys and headers (`resolve-config-value.ts`, reached from
 * `auth-storage.ts` and `model-registry.ts`) and MCP server config
 * (`extensions/builtin/mcp/config.ts`, also used by MCP skill servers).
 *
 * The reference is deliberately resolved at load time rather than inlined into
 * the config that names it. Inlining copies a secret's bytes into a second and
 * third plaintext file, and that copy goes stale the moment the original is
 * rotated. Keeping the reference means the file the user already curates stays
 * the single source of truth.
 *
 * Decisions worth preserving:
 *
 * - Only TRAILING whitespace is stripped from the body. Credential files
 *   conventionally end in a newline and that newline must not become part of
 *   the secret; interior whitespace is content and is preserved.
 * - Symlinks are neither resolved nor refused. `{file:/home/u/.creds/x}` is the
 *   user's stated trust decision and `readFileSync` already follows it; calling
 *   `realpath` first would add a policy gate (and a check-then-open window) on
 *   top of a choice the user has already made. There is deliberately no
 *   permission-MODE policy either: a readable file resolves, and only a failed
 *   read refuses.
 * - Path shape is checked before the filesystem is touched, and every read error
 *   refuses. A relative path is an error rather than a resolve-against-cwd
 *   guess, because a config file has no well-defined cwd to resolve against.
 * - Failures always name the path and the reason. A bare `ENOENT` is not
 *   actionable for a credential someone wired up deliberately.
 */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * A `{file:<path>}` placeholder that could not be resolved. `ref` is the
 * reference exactly as the user wrote it and `reason` names the path plus what
 * went wrong, so a caller can add its own context without re-deriving either.
 */
export class ConfigFileRefError extends Error {
	readonly ref: string;
	readonly reason: string;

	constructor(ref: string, reason: string) {
		super(`Failed to resolve {file:${ref}}: ${reason}`);
		this.name = "ConfigFileRefError";
		this.ref = ref;
		this.reason = reason;
	}
}

/**
 * Text between two `{file:...}` placeholders, or a placeholder reference.
 * Callers run their own placeholder pass over the `literal` segments only, so a
 * resolved file body is never re-scanned and cannot smuggle in a second lookup.
 */
export type ConfigFileRefSegment = { type: "literal"; value: string } | { type: "file"; ref: string };

// Only ever used with String.prototype.replace, which resets lastIndex itself.
// A `.test()`/`.exec()` call against this same object would make it stateful.
const FILE_REF_PATTERN = /\{file:([^}]*)\}/g;

/** A `}` inside a path is not supported; the reference ends at the first `}`. */
export function splitConfigFileRefs(value: string): ConfigFileRefSegment[] {
	const segments: ConfigFileRefSegment[] = [];
	let index = 0;
	for (const match of value.matchAll(FILE_REF_PATTERN)) {
		const start = match.index;
		if (start > index) segments.push({ type: "literal", value: value.slice(index, start) });
		segments.push({ type: "file", ref: match[1] ?? "" });
		index = start + match[0].length;
	}
	if (index < value.length) segments.push({ type: "literal", value: value.slice(index) });
	return segments;
}

function expandHome(ref: string, expanded: string): string {
	if (expanded !== "~" && !expanded.startsWith("~/") && !expanded.startsWith("~\\")) return expanded;
	// HOME is checked first so the behavior is exactly what the config implies;
	// USERPROFILE only matters on Windows, where HOME is usually unset.
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home)
		throw new ConfigFileRefError(ref, `cannot expand ~ for {file:${ref}}: neither HOME nor USERPROFILE is set`);
	return expanded === "~" ? home : home + expanded.slice(1);
}

function describeReadFailure(path: string, error: unknown): string {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
	if (code === "ENOENT") return `file does not exist: ${path}`;
	if (code === "EACCES" || code === "EPERM") return `permission denied: ${path}`;
	if (code === "EISDIR") return `not a readable file: ${path}`;
	const message = error instanceof Error ? error.message : String(error);
	const prefix = code ? `${code}: ` : "";
	return `${prefix}${message} (${path})`;
}

/**
 * Read one `{file:<path>}` reference and return its body with trailing
 * whitespace removed. Throws `ConfigFileRefError` on every failure mode.
 */
export function resolveConfigFileRef(ref: string): string {
	const trimmedRef = ref.trim();
	const expanded = expandHome(trimmedRef, trimmedRef);
	if (!isAbsolute(expanded)) {
		throw new ConfigFileRefError(trimmedRef, `absolute path required, got ${expanded}`);
	}
	// One read, no stat/read window: the error is whatever the read reports.
	let body: string;
	try {
		body = readFileSync(expanded, "utf-8");
	} catch (error) {
		throw new ConfigFileRefError(trimmedRef, describeReadFailure(expanded, error));
	}
	// Only TRAILING whitespace goes: \s and trimEnd cover the same set, so the
	// credential-file newline convention never becomes part of the secret while
	// interior whitespace is preserved. No regex, so no backtracking to reason about.
	const trimmedBody = body.trimEnd();
	if (trimmedBody.length === 0) {
		throw new ConfigFileRefError(trimmedRef, `file is empty: ${expanded}`);
	}
	return trimmedBody;
}
